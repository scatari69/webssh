-- 001_init — исходная схема.
--
-- Времена везде — UTC ISO-8601 в TEXT (SQLite не имеет типа даты, а такой
-- формат сортируется лексикографически и однозначно читается человеком).

-- ---------------------------------------------------------------- users
--
-- Пароли меняет только администратор, самообслуживания нет. Удаления тоже
-- нет: учётка деактивируется (is_active = 0), поэтому записи аудита и
-- ссылки created_by/updated_by остаются целыми, а имя пользователя больше
-- никогда не переиспользуется.
CREATE TABLE users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash       TEXT    NOT NULL,
  role                TEXT    NOT NULL CHECK (role IN ('admin', 'user')),
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),

  -- Двухфакторка: обязательна для роли admin (TOTP_REQUIRED_FOR_ADMIN),
  -- для роли user — по желанию. Секрет шифруется secretbox с контекстом
  -- 'users:totp_secret:<id>'.
  totp_secret_enc     BLOB,
  totp_enabled        INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  totp_confirmed_at   TEXT,

  -- Защита от перебора. Блокировка учётки дополняет заградительный лимит
  -- по IP: первый барьер держит флуд, второй — точечный подбор пароля.
  failed_login_count  INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT,

  last_login_at       TEXT,
  -- Момент последней смены пароля администратором. Сессии и живые терминалы,
  -- открытые раньше этой отметки, считаются недействительными.
  password_changed_at TEXT,

  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by          INTEGER REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX idx_users_role_active ON users (role, is_active);

-- ------------------------------------------------------- recovery_codes
--
-- Одноразовые коды восстановления на случай потери TOTP-устройства.
-- Хранятся как bcrypt-хеши: утечка таблицы не даёт готовых кодов.
CREATE TABLE recovery_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  TEXT    NOT NULL,
  used_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_recovery_codes_user ON recovery_codes (user_id, used_at);

-- ------------------------------------------------------------ ssh_config
--
-- Ровно одна строка: хост общий для всех пользователей приложения.
-- CHECK (id = 1) делает второй хост невозможным физически, а не по
-- договорённости.
--
-- Приватный ключ лежит файлом в SSH_KEYS_DIR (том /keys, права 0600,
-- владелец — непривилегированный uid приложения); в БД — только путь.
-- Passphrase шифруется secretbox с контекстом 'ssh_config:passphrase:1'.
-- Наружу через API не отдаётся ни то, ни другое: админка знает лишь
-- отпечаток публичной части и тип ключа.
CREATE TABLE ssh_config (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  host                    TEXT    NOT NULL DEFAULT '',
  port                    INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  ssh_username            TEXT    NOT NULL DEFAULT '',

  private_key_path        TEXT,
  private_key_fingerprint TEXT,
  private_key_type        TEXT,
  passphrase_enc          BLOB,

  -- Верификация ключа хоста. Без неё ssh2 принимает любой предъявленный
  -- ключ, то есть соединение уязвимо к MITM. tofu: первый ключ
  -- запоминается и дальше сверяется строго.
  host_key_policy         TEXT    NOT NULL DEFAULT 'tofu'
                            CHECK (host_key_policy IN ('tofu', 'pinned', 'insecure')),
  known_host_key          TEXT,
  known_host_fingerprint  TEXT,

  keepalive_interval_ms   INTEGER NOT NULL DEFAULT 30000,
  connect_timeout_ms      INTEGER NOT NULL DEFAULT 15000,

  updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by              INTEGER REFERENCES users (id) ON DELETE SET NULL
);

-- Ненастроенное состояние: пока host пуст, пользователь при входе получает
-- внятное «сервер не настроен», а не ошибку соединения.
INSERT INTO ssh_config (id) VALUES (1);

-- ------------------------------------------------------------- audit_log
--
-- Поскольку SSH-идентичность на целевом хосте одна на всех, этот журнал —
-- единственный источник ответа на вопрос «кто именно это сделал».
-- actor_username денормализовано намеренно: запись должна оставаться
-- читаемой независимо от судьбы строки в users.
CREATE TABLE audit_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER REFERENCES users (id) ON DELETE SET NULL,
  actor_username      TEXT,
  action              TEXT    NOT NULL,
  outcome             TEXT    NOT NULL DEFAULT 'success'
                        CHECK (outcome IN ('success', 'failure')),
  target_type         TEXT,
  target_id           TEXT,
  -- Сшивает события одной терминальной сессии: open → detach → reattach → close.
  terminal_session_id TEXT,
  ip                  TEXT,
  user_agent          TEXT,
  -- JSON. Заполняется только через services/audit.js, который вычищает
  -- секреты: ключи, passphrase, пароли, TOTP-коды сюда попадать не должны.
  detail              TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_audit_created         ON audit_log (created_at DESC);
CREATE INDEX idx_audit_user_created    ON audit_log (user_id, created_at DESC);
CREATE INDEX idx_audit_action_created  ON audit_log (action, created_at DESC);
CREATE INDEX idx_audit_terminal        ON audit_log (terminal_session_id);
