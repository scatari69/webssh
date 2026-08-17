'use strict';

const express = require('express');
const helmet = require('helmet');

const config = require('./config');
const healthRoutes = require('./routes/health');

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

  app.use('/api', healthRoutes);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Наружу уходит только код ошибки: стектрейсы и сообщения драйвера БД
  // могут содержать пути, SQL и фрагменты значений.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(err.status || 500).json({ error: err.publicCode || 'internal_error' });
  });

  return app;
}

module.exports = { createApp };
