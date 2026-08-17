'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { beforeEach, describe, it } = require('node:test');

const ctx = require('./helpers/context');

const config = require('../src/config');
const manager = require('../src/ssh/manager');
const { TerminalSession } = require('../src/ssh/session');
const { CLOSE, parseClientMessage } = require('../src/ws/protocol');

/** Сокет-заглушка: нужен только приём сообщений и факт закрытия. */
class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.CONNECTING = 0;
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closedWith = null;
  }

  send(payload) {
    this.sent.push(payload);
  }

  close(code, reason) {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
}

function jsonFrame(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

describe('лимиты WebSocket-канала', () => {
  describe('размер сообщения', () => {
    it('кадр сверх предела отклоняется', () => {
      const oversized = Buffer.alloc(config.limits.wsMaxMessageBytes + 1, 0x61);
      const result = parseClientMessage(oversized, false);

      assert.equal(result.type, 'error');
      assert.equal(result.error, 'message_too_large');
    });

    it('кадр в пределах лимита разбирается как обычно', () => {
      // С запасом на обвязку JSON.
      const payload = 'a'.repeat(config.limits.wsMaxMessageBytes - 128);
      const result = parseClientMessage(jsonFrame({ type: 'data', data: payload }), false);

      assert.equal(result.type, 'data');
      assert.equal(result.data.length, payload.length);
    });

    it('предел считается в байтах, а не в символах', () => {
      // Кириллица — два байта на символ: по длине строки такой кадр прошёл
      // бы, по длине в байтах — нет. Проверяем именно это различие.
      const chars = Math.floor(config.limits.wsMaxMessageBytes / 2) + 10;
      const frame = Buffer.from('я'.repeat(chars), 'utf8');

      assert.ok(frame.length > config.limits.wsMaxMessageBytes);
      assert.equal(parseClientMessage(frame, false).error, 'message_too_large');
    });

    it('предел настраивается и по умолчанию заметно ниже мегабайта', () => {
      assert.ok(config.limits.wsMaxMessageBytes >= 1024);
      assert.ok(
        config.limits.wsMaxMessageBytes <= 1024 * 1024,
        `предел ${config.limits.wsMaxMessageBytes} байт слишком велик по умолчанию`
      );
    });
  });

  describe('простой сессии', () => {
    let user;

    beforeEach(async () => {
      ctx.resetDb();
      user = await ctx.createUser({ username: 'idler', role: 'user' });
    });

    function makeIdleSession() {
      const ws = new FakeWs();
      const session = new TerminalSession({ ws, user, ip: '10.0.0.1', userAgent: 'test' });
      session.attachClientHandlers();
      // Отматываем назад ровно за границу лимита.
      session.lastActivityAt = Date.now() - config.limits.idleTimeoutMs - 1000;
      return { ws, session };
    }

    it('простаивающая сессия считается простаивающей', () => {
      const { session } = makeIdleSession();
      assert.equal(session.isIdle(), true);
    });

    it('ввод пользователя сбрасывает отсчёт', () => {
      const { ws, session } = makeIdleSession();

      ws.emit('message', jsonFrame({ type: 'data', data: 'ls\n' }), false);

      assert.equal(session.isIdle(), false);
    });

    it('изменение размера окна тоже считается активностью', () => {
      const { ws, session } = makeIdleSession();

      ws.emit('message', jsonFrame({ type: 'resize', cols: 100, rows: 30 }), false);

      assert.equal(session.isIdle(), false);
    });

    it('keepalive-пинг простой НЕ продлевает', () => {
      const { ws, session } = makeIdleSession();

      ws.emit('message', jsonFrame({ type: 'ping' }), false);

      // Ответ на пинг ушёл — соединение живо и клиент это знает.
      assert.equal(session.isIdle(), true, 'пинг не должен считаться активностью человека');
      assert.ok(
        ws.sent.some((raw) => String(raw).includes('pong')),
        'на пинг всё равно нужно отвечать'
      );
    });

    it('мусорное сообщение активностью не считается', () => {
      const { ws, session } = makeIdleSession();

      ws.emit('message', Buffer.from('не json', 'utf8'), false);

      assert.equal(session.isIdle(), true);
    });

    it('сборщик закрывает простаивающую сессию и сообщает причину', () => {
      const { ws, session } = makeIdleSession();
      manager.register(session);

      const closed = manager.sweepIdle();

      assert.equal(closed, 1);
      assert.equal(ws.closedWith.code, CLOSE.IDLE_TIMEOUT);
      assert.equal(manager.size, 0, 'закрытая сессия должна выпасть из реестра');

      // Причина попадает в журнал: иначе разобраться, почему у человека
      // пропал терминал, будет негде.
      const actions = ctx.auditActions();
      const close = actions.find((entry) => entry.action === 'terminal.close');
      assert.ok(close, 'закрытие должно быть в журнале');
      assert.match(close.detail, /idle_timeout/);
    });

    it('активная сессия сборщиком не трогается', () => {
      const ws = new FakeWs();
      const session = new TerminalSession({ ws, user, ip: null, userAgent: null });
      session.attachClientHandlers();
      manager.register(session);

      assert.equal(manager.sweepIdle(), 0);
      assert.equal(ws.closedWith, null);

      manager.closeAll('test_cleanup');
    });
  });
});
