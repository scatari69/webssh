'use strict';

const assert = require('node:assert/strict');
const { beforeEach, describe, it } = require('node:test');

const ctx = require('./helpers/context');

describe('страницы и статика', () => {
  beforeEach(async () => {
    ctx.resetDb();
    await ctx.createUser({ username: 'admin', role: 'admin' });
    await ctx.createUser({ username: 'member', role: 'user' });
  });

  describe('маршруты страниц', () => {
    it('гостя с корня уводит на форму входа', async () => {
      const res = await ctx.request(ctx.app).get('/');

      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/login');
    });

    it('форма входа отдаётся без сессии', async () => {
      const res = await ctx.request(ctx.app).get('/login');

      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/html/);
      // Страницы не кешируются: после выкатки должна приходить новая.
      assert.match(res.headers['cache-control'], /no-store/);
    });

    it('вошедшего с формы входа уводит в терминал', async () => {
      const { agent } = await ctx.loginAs('member');
      const res = await agent.get('/login');

      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/');
    });

    it('терминал отдаётся вошедшему', async () => {
      const { agent } = await ctx.loginAs('member');
      const res = await agent.get('/');

      assert.equal(res.status, 200);
      assert.match(res.text, /terminal-host/);
    });

    it('админка закрыта для обычного пользователя и открыта администратору', async () => {
      const { agent: member } = await ctx.loginAs('member');
      const denied = await member.get('/admin');
      assert.equal(denied.status, 302);
      assert.equal(denied.headers.location, '/');

      const { agent: admin } = await ctx.loginAs('admin');
      const allowed = await admin.get('/admin');
      assert.equal(allowed.status, 200);
    });

    it('настройки второго фактора: гостя уводит, вошедшего пускает', async () => {
      const guest = await ctx.request(ctx.app).get('/account');
      assert.equal(guest.status, 302);
      assert.equal(guest.headers.location, '/login');

      // Второй фактор доброволен для обычной роли, поэтому страница обязана
      // открываться и ей: до неё включить его было негде вообще.
      const { agent } = await ctx.loginAs('member');
      const res = await agent.get('/account');
      assert.equal(res.status, 200);
      assert.match(res.text, /account\.js/);
    });

    it('гостя из админки уводит на форму входа', async () => {
      const res = await ctx.request(ctx.app).get('/admin');

      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/login');
    });

    it('страницы не отдаются по прямому имени файла в обход проверки', async () => {
      for (const file of ['/terminal.html', '/admin.html', '/login.html']) {
        const res = await ctx.request(ctx.app).get(file);
        assert.notEqual(res.status, 200, `${file} не должен отдаваться напрямую`);
      }
    });
  });

  describe('статика', () => {
    it('отдаёт стили и модули фронтенда', async () => {
      const css = await ctx.request(ctx.app).get('/css/base.css');
      assert.equal(css.status, 200);
      assert.match(css.headers['content-type'], /text\/css/);

      const js = await ctx.request(ctx.app).get('/js/terminal/main.js');
      assert.equal(js.status, 200);
      assert.match(js.headers['content-type'], /javascript/);
    });

    it('отдаётся с условным кешем: обновление доезжает без жёсткой перезагрузки', async () => {
      /*
       * max-age здесь был причиной настоящей поломки: страницы приходят с
       * no-store и после выкатки свежие, а модули к ним оставались в кеше
       * до часа. Свежая разметка встречалась со вчерашним кодом.
       */
      for (const target of ['/css/base.css', '/js/admin/users.js', '/vendor/xterm.mjs']) {
        const res = await ctx.request(ctx.app).get(target);

        assert.equal(res.status, 200, target);
        assert.match(res.headers['cache-control'], /no-cache/, `${target}: ${res.headers['cache-control']}`);
        assert.ok(res.headers.etag, `${target}: нет ETag`);

        // Неизменившийся файл отдаётся как 304 без тела — цена условного
        // запроса, ради которой всё и затевалось.
        const revalidated = await ctx
          .request(ctx.app)
          .get(target)
          .set('If-None-Match', res.headers.etag);
        assert.equal(revalidated.status, 304, `${target} должен отвечать 304`);
      }
    });

    it('не выпускает за пределы каталога статики', async () => {
      const res = await ctx.request(ctx.app).get('/css/../../server/package.json');
      assert.notEqual(res.status, 200);
    });
  });

  describe('xterm.js из node_modules', () => {
    it('отдаёт модули и стили с правильным типом', async () => {
      const cases = [
        ['/vendor/xterm.mjs', /javascript/],
        ['/vendor/addon-fit.mjs', /javascript/],
        ['/vendor/addon-search.mjs', /javascript/],
        ['/vendor/addon-web-links.mjs', /javascript/],
        ['/vendor/xterm.css', /text\/css/],
      ];

      for (const [path, contentType] of cases) {
        const res = await ctx.request(ctx.app).get(path);
        assert.equal(res.status, 200, `${path} должен отдаваться`);
        assert.match(res.headers['content-type'], contentType, path);
        assert.ok(res.text.length > 100, `${path} не должен быть пустым`);
      }
    });

    it('список файлов закрытый — произвольный путь не проходит', async () => {
      for (const path of ['/vendor/package.json', '/vendor/..%2fpackage.json', '/vendor/xterm.js.map']) {
        const res = await ctx.request(ctx.app).get(path);
        assert.notEqual(res.status, 200, `${path} не должен отдаваться`);
      }
    });
  });

  describe('политика безопасности содержимого', () => {
    it('запрещает внешние источники и вставку в рамку', async () => {
      const res = await ctx.request(ctx.app).get('/login');
      const csp = res.headers['content-security-policy'];

      assert.ok(csp, 'заголовок CSP должен присутствовать');
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      // Инлайновых скриптов на страницах нет — послабления быть не должно.
      assert.equal(/script-src[^;]*unsafe-inline/.test(csp), false);
      // Адрес WebSocket указан явно.
      assert.match(csp, /connect-src [^;]*ws/);
    });
  });
});
