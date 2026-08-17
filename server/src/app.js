'use strict';

const express = require('express');
const helmet = require('helmet');

const config = require('./config');
const { requireAdmin } = require('./auth/rbac');
const { createSessionMiddleware } = require('./auth/session');
const { createLoginRateLimiter, createTotpRateLimiter } = require('./middleware/rateLimit');
const adminSshConfigRoutes = require('./routes/admin.sshConfig');
const adminUserRoutes = require('./routes/admin.users');
const authRoutes = require('./routes/auth');
const healthRoutes = require('./routes/health');
const totpRoutes = require('./routes/totp');

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
      // CSP будет настроен вместе с фронтендом: политика зависит от того,
      // как подключаются xterm.js и его аддоны. Дефолтная политика helmet
      // сломала бы статику ещё до того, как она появится.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
    })
  );

  app.use(express.json({ limit: '256kb' }));

  app.use(createSessionMiddleware());

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
  app.use('/api/admin', adminRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
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
