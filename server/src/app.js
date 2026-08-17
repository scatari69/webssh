'use strict';

const path = require('node:path');

const express = require('express');
const helmet = require('helmet');

const config = require('./config');
const { requireAdmin } = require('./auth/rbac');
const { createSessionMiddleware } = require('./auth/session');
const { createLoginRateLimiter, createTotpRateLimiter } = require('./middleware/rateLimit');
const adminAuditRoutes = require('./routes/admin.audit');
const adminSshConfigRoutes = require('./routes/admin.sshConfig');
const adminUserRoutes = require('./routes/admin.users');
const authRoutes = require('./routes/auth');
const healthRoutes = require('./routes/health');
const { WEB_ROOT, pagesRouter } = require('./routes/pages');
const totpRoutes = require('./routes/totp');
const vendorRoutes = require('./routes/vendor');

/**
 * Источники для connect-src. Одного 'self' формально хватает и для
 * WebSocket того же происхождения, но реализации в браузерах расходились,
 * поэтому адрес указывается явно.
 */
function websocketOrigins() {
  try {
    const url = new URL(config.publicOrigin);
    const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return [`${scheme}//${url.host}`];
  } catch {
    return [];
  }
}

function createApp() {
  const app = express();

  // Приложение всегда работает за Caddy. Значение — число, а не true:
  // доверять произвольной цепочке X-Forwarded-For нельзя, иначе клиент
  // подделает свой адрес и обойдёт лимиты и блокировки.
  app.set('trust proxy', config.trustProxyHops);
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(
    helmet({
      // HSTS выставляет Caddy — он терминирует TLS и знает, включён ли он.
      strictTransportSecurity: false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          // Весь код свой: xterm.js раздаётся с этого же origin, внешних
          // источников нет вовсе. Инлайновых скриптов тоже нет.
          scriptSrc: ["'self'"],
          // 'unsafe-inline' нужен только стилям: xterm создаёт собственный
          // элемент <style> для размеров глифов и декораций.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'", ...websocketOrigins()],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
    })
  );

  app.use(express.json({ limit: '256kb' }));

  // Тот же экземпляр понадобится обработчику upgrade: WebSocket
  // аутентифицируется той же cookie, что и REST.
  const sessionMiddleware = createSessionMiddleware();
  app.set('sessionMiddleware', sessionMiddleware);
  app.use(sessionMiddleware);

  // Лимит навешивается до маршрута, то есть до обращения к bcrypt.
  app.use('/api/login', createLoginRateLimiter());
  app.use('/api/totp/verify', createTotpRateLimiter());

  app.use('/api', healthRoutes);
  app.use('/api', authRoutes);
  app.use('/api/totp', totpRoutes);

  // Единый роутер, а не requireAdmin на каждом app.use('/api/admin', …):
  // во втором случае проверка (вместе с запросом к БД) выполнялась бы по
  // разу на каждый смонтированный роутер, даже когда путь ему не подходит.
  const adminRouter = express.Router();
  adminRouter.use(requireAdmin);
  adminRouter.use(adminUserRoutes);
  adminRouter.use(adminSshConfigRoutes);
  adminRouter.use(adminAuditRoutes);
  app.use('/api/admin', adminRouter);

  app.use('/vendor', vendorRoutes);
  app.use(pagesRouter);

  // Раздаются только каталоги ресурсов, а не web/ целиком: иначе страницы
  // были бы доступны по прямому имени файла в обход проверки сессии и
  // редиректов из pagesRouter.
  const staticOptions = { index: false, fallthrough: true, maxAge: '1h' };
  for (const dir of ['css', 'js', 'assets']) {
    app.use(`/${dir}`, express.static(path.join(WEB_ROOT, dir), staticOptions));
  }

  app.use((req, res) => {
    // Браузеру, зашедшему за страницей, полезнее увидеть форму входа, чем
    // JSON с ошибкой.
    if (req.method === 'GET' && (req.get('accept') || '').includes('text/html')) {
      return res.redirect('/login');
    }
    return res.status(404).json({ error: 'not_found' });
  });

  // Наружу уходит только код ошибки: стектрейсы и сообщения драйвера БД
  // могут содержать пути, SQL и фрагменты значений.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    // Ошибки разбора тела — это ошибки клиента, и отвечать на них
    // «внутренней ошибкой» значит отправлять отладку не в ту сторону.
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }

    console.error('[error]', err);
    return res.status(err.status || 500).json({ error: err.publicCode || 'internal_error' });
  });

  return app;
}

module.exports = { createApp };
