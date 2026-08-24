/**
 * Локализация интерфейса: русский, украинский, английский.
 *
 * Словарь один на всё приложение и лежит в статике — отдельного запроса за
 * переводом нет, поэтому язык применяется до первой отрисовки и страница не
 * успевает мигнуть чужим языком.
 *
 * Тексты ошибок, приходящие с сервера, переводятся здесь же по коду ошибки
 * (`err.*`), а не берутся из поля `message` ответа: сервер не знает, на
 * каком языке смотрит человек, и один и тот же код должен читаться на
 * выбранном языке. Серверная строка остаётся запасным вариантом для кодов,
 * которых тут ещё нет.
 */

const STORAGE_KEY = 'webssh.lang';

export const LANGS = {
  ru: { label: 'Русский', short: 'RU', htmlLang: 'ru' },
  uk: { label: 'Українська', short: 'UA', htmlLang: 'uk' },
  en: { label: 'English', short: 'EN', htmlLang: 'en' },
};

export const LANG_IDS = Object.keys(LANGS);

const DICT = {
  /* =============================================================== ru */
  ru: {
    lang: { group: 'Язык', changed: 'Язык: {name}' },
    theme: { group: 'Тема оформления', changed: 'Тема: {name}' },

    login: {
      pageTitle: 'Вход — webssh',
      subtitleSignIn: 'Вход в терминал',
      subtitleVerify: 'Подтверждение входа',
      subtitleEnroll: 'Привязка двухфакторной аутентификации',
      subtitleRecovery: 'Коды восстановления',
      username: 'Логин',
      password: 'Пароль',
      submit: 'Войти',
      checking: 'Проверяем…',
      fillBoth: 'Заполните оба поля.',
      serverUnavailable: 'Сервер недоступен.',
      verifyHint: 'Введите код из приложения-аутентификатора или один из кодов восстановления.',
      code: 'Код',
      verifySubmit: 'Подтвердить',
      restart: 'Начать заново',
      enrollHint:
        'Для этой учётной записи нужна двухфакторная аутентификация. Добавьте секрет в приложение-аутентификатор и подтвердите кодом.',
      enrollOpenApp: 'Открыть в приложении-аутентификаторе',
      enrollManual: 'Или введите секрет вручную',
      copySecret: 'Скопировать секрет',
      enrollCode: 'Код из приложения',
      enrollSubmit: 'Привязать и войти',
      enrollFailed: 'Не удалось начать привязку.',
      recoveryWarn:
        'Сохраните коды восстановления. Они показываются один раз и заменяют код из приложения, если устройство потеряно.',
      copyAll: 'Скопировать все',
      recoveryDone: 'Я сохранил коды, продолжить',
      copied: 'Скопировано',
      copyManually: 'Скопируйте вручную',
    },

    term: {
      pageTitle: 'Терминал — webssh',
      statusConnecting: 'Подключение…',
      statusConnected: 'Подключено',
      statusClosed: 'Сессия завершена',
      statusDropped: 'Соединение разорвано',
      statusRetryIn: 'Соединение разорвано, переподключение через {seconds} с',
      statusError: 'Ошибка соединения',
      connectingTitle: 'Подключение…',
      connectingMessage: 'Устанавливаем SSH-соединение с хостом.',
      droppedTitle: 'Соединение разорвано',
      retryIn: 'Повторная попытка через {seconds} с.',
      retryNow: 'Переподключиться сейчас',
      closedTitle: 'Сессия завершена',
      closedMessage: 'Шелл на хосте закрыт.',
      reopen: 'Открыть заново',
      loginRequiredTitle: 'Требуется вход',
      loginRequiredMessage: 'Сессия истекла или учётная запись отключена.',
      goToLogin: 'На страницу входа',
      failedTitle: 'Не удалось подключиться',
      failedMessage: 'Соединение закрыто сервером. Подробности могут быть в журнале администратора.',
      retry: 'Попробовать снова',
      searchTitle: 'Поиск (Ctrl+Shift+F)',
      searchPlaceholder: 'Поиск по выводу',
      searchPrev: 'Назад',
      searchNext: 'Вперёд',
      searchClose: 'Закрыть поиск',
      themeTitle: 'Тема оформления',
      menuTitle: 'Меню',
      adminTitle: 'Админка',
      logoutTitle: 'Выйти',
      specialKeys: 'Специальные клавиши',
      logTruncated: '# Начало журнала обрезано: сохранены последние {count} символов',
    },

    menu: {
      copy: 'Копировать',
      noSelection: 'нет выделения',
      paste: 'Вставить',
      clear: 'Очистить экран',
      reset: 'Сбросить терминал',
      find: 'Найти…',
      fontSize: 'Размер шрифта',
      smaller: 'Уменьшить шрифт',
      larger: 'Увеличить шрифт',
      downloadLog: 'Скачать журнал сессии',
    },

    toast: {
      copied: 'Скопировано',
      nothingSelected: 'Ничего не выделено',
      copyNeedsHttps: 'Копирование недоступно без HTTPS',
      pasteUnavailable: 'Вставка недоступна: используйте Cmd/Ctrl+V или жест системы',
      fontSize: 'Размер шрифта: {size}',
    },

    account: {
      pageTitle: 'Двухфакторная аутентификация — webssh',
      title: 'Двухфакторная аутентификация',
      stateOn: 'Второй фактор включён.',
      stateOff: 'Второй фактор выключен.',
      since: 'Привязан {date}.',
      codesLeft: 'Кодов восстановления осталось: {count}.',
      codesGone: 'Коды закончились — перевыпустите их, иначе потеря телефона будет означать потерю доступа.',
      requiredHint: 'Для вашей роли второй фактор обязателен: следующий вход начнётся с привязки.',
      enable: 'Включить',
      enrollHint: 'Добавьте секрет в приложение-аутентификатор и подтвердите кодом.',
      confirm: 'Подтвердить',
      cancel: 'Отмена',
      currentCode: 'Код из приложения',
      codeHint: 'Подтвердите, что устройство при вас',
      codeRequired: 'Введите код из приложения.',
      regenerate: 'Перевыпустить коды восстановления',
      disable: 'Отключить второй фактор',
      disabled: 'Второй фактор отключён',
      toTerminal: 'К терминалу',
    },

    admin: {
      pageTitle: 'Администрирование — webssh',
      title: 'Администрирование',
      checking: 'Проверяем доступ…',
      whoami: 'Вы вошли как {user}',
      onlyAdmins: 'Раздел доступен только администраторам.',
      toTerminal: 'К терминалу',
      logout: 'Выйти',
      refresh: 'Обновить',
      sessionStale: 'Сервер недоступен.',
    },

    users: {
      title: 'Пользователи',
      hint: 'Учётные записи веб-приложения. К SSH-хосту все они подключаются под одним и тем же системным пользователем — различить, кто именно что сделал, можно только по журналу ниже.',
      colLogin: 'Логин',
      colRole: 'Роль',
      colCreated: 'Создан',
      colState: 'Состояние',
      colActions: 'Действия',
      roleAdmin: 'администратор',
      roleUser: 'пользователь',
      stateActive: 'активен',
      stateDisabled: 'отключён',
      has2fa: '2FA',
      no2fa: 'без 2FA',
      you: 'это вы',
      empty: 'Пользователей нет.',
      loadFailed: 'Список не загрузился.',
      createTitle: 'Создать пользователя',
      usernameHint: '3–32 символа: латиница, цифры, точка, дефис, подчёркивание',
      roleHint: 'Администратору двухфакторка обязательна',
      passwordPlaceholder: 'не короче 12 символов',
      generate: 'Сгенерировать',
      create: 'Создать',
      resetPassword: 'Сбросить пароль',
      reset2fa: 'Сбросить 2FA',
      disable: 'Отключить',
      enable: 'Включить',
      confirmDisableTitle: 'Отключить «{user}»?',
      confirmDisableSelf:
        'Это ваша собственная учётная запись: после отключения вы потеряете доступ к админке. ',
      confirmDisableBody:
        'Учётная запись останется в базе, но войти по ней будет нельзя, а открытые терминалы закроются сразу. Включить обратно можно кнопкой рядом.',
      disabledToast: '«{user}» отключён',
      disabledToastWithTerminals: '«{user}» отключён, терминалов закрыто: {count}',
      enabledToast: '«{user}» включён',
      confirmResetTitle: 'Сбросить пароль «{user}»?',
      confirmResetSelf:
        'Это ваша собственная учётная запись: после смены пароля текущая сессия перестанет действовать и войти придётся заново — уже с новым паролем. ',
      newPasswordSelfMessage:
        'Это пароль вашей учётной записи. Сохраните его сейчас: сессия уже недействительна, и после закрытия окна откроется форма входа.',
      passwordChangedSelfTitle: 'Пароль изменён',
      confirmResetBody:
        'Открытые веб-сессии и терминалы этого пользователя закроются немедленно. Новый пароль показывается один раз — восстановить его потом неоткуда.',
      newPasswordPlaceholder: 'будет сгенерирован',
      passwordTooShort: 'Пароль короче {min} символов.',
      newPasswordTitle: 'Новый пароль',
      newPasswordMessage: 'Передайте его пользователю «{user}». Больше он нигде не появится.',
      passwordChanged: 'Пароль «{user}» изменён',
      confirm2faTitle: 'Сбросить двухфакторку «{user}»?',
      confirm2faBody:
        'Привязка и коды восстановления удалятся. Если для этой роли второй фактор обязателен, следующий вход начнётся с новой привязки.',
      reset2faToast: 'Двухфакторка «{user}» сброшена',
      createdTitle: 'Пользователь «{user}» создан',
      createdMessage: 'Пароль показывается один раз — передайте его и закройте окно.',
      createdToast: 'Пользователь «{user}» создан',
    },

    ssh: {
      title: 'SSH-хост',
      warn: 'Хост в приложении один и общий для всех. Любой, кто вошёл в веб-интерфейс, получает на нём полноценный шелл под указанным ниже системным пользователем и с указанным ключом — своих учётных данных никто не вводит. Смена адреса или ключа действует сразу и на всех.',
      address: 'Адрес',
      notConfigured: 'не настроен',
      notConfiguredAll: ' — терминал недоступен всем',
      missingKey: ' — не хватает ключа',
      key: 'Ключ',
      keyMissing: 'не загружен',
      unknownType: 'неизвестный тип',
      passphrase: 'Passphrase',
      passphraseSet: 'задана',
      passphraseNone: 'нет',
      hostKey: 'Ключ хоста',
      policyTofu: 'запоминается при первом подключении',
      policyPinned: 'сверяется строго',
      policyInsecure: 'не проверяется',
      hostKeyUnknown: 'ключ хоста ещё не запомнен',
      updated: 'Обновлено',
      editTitle: 'Изменить',
      host: 'Хост',
      port: 'Порт',
      sshUser: 'Пользователь SSH',
      privateKey: 'Приватный ключ',
      keyHint:
        'Оставьте пустым — сохранённый ключ не изменится. Подходит формат OpenSSH и классический PEM; PKCS#8 (BEGIN PRIVATE KEY) библиотека ssh2 не читает. Ключ никогда не отображается обратно — заменить можно, посмотреть нельзя.',
      passphraseLabel: 'Passphrase ключа',
      passphrasePlaceholder: 'не менять',
      clearPassphrase: 'Убрать сохранённую passphrase',
      save: 'Сохранить',
      resetForm: 'Сбросить форму',
      confirmTitle: 'Изменить настройки хоста?',
      consequenceKey:
        'Сохранённый приватный ключ будет заменён безвозвратно — прежний нигде не хранится и восстановить его отсюда нельзя.',
      consequenceHostKey:
        'Адрес меняется, поэтому запомненный ключ хоста будет сброшен: ключ нового сервера примется при первом подключении без сверки.',
      consequencePassphrase: 'Сохранённая passphrase будет удалена.',
      affectsAll: 'Изменение затронет всех пользователей приложения сразу.',
      saved: 'Настройки хоста сохранены',
      test: 'Проверить подключение',
      testing: 'Проверяем подключение…',
      testOk: 'Подключение прошло: хост принял ключ.',
      testOkLearned: 'Подключение прошло, ключ хоста запомнен: {fingerprint}',
      testFailed: 'Подключиться не удалось.',
      testPresented: 'Хост предъявил {fingerprint}.',
      'hint.loopback_in_container':
        'Адрес — петлевой, а приложение работает в контейнере: внутри него 127.0.0.1 и localhost указывают на сам контейнер, а не на машину. Проверка из консоли сервера этого не показывает. Укажите адрес машины в сети (или адрес шлюза docker), а не петлевой.',
      keyLoaded: 'Ключ загружен из «{file}»',
      notAKey: 'Не похоже на приватный ключ — проверьте, не выбран ли публичный (.pub).',
      tooLarge: 'Файл слишком велик для приватного ключа.',
      readFailed: 'Не удалось прочитать файл.',
      portInvalid: 'Порт должен быть числом от 1 до 65535.',
    },

    audit: {
      title: 'Журнал',
      hint: 'Последние 100 записей, новые сверху. Содержимое терминала не пишется — только факты входа, действий администратора и открытия/закрытия SSH-сессий.',
      colTime: 'Время',
      colAction: 'Действие',
      colActor: 'Кто',
      colOutcome: 'Итог',
      colTarget: 'Объект',
      colIp: 'Адрес',
      colDetail: 'Подробности',
      success: 'успех',
      failure: 'отказ',
      empty: 'Журнал пуст.',
      loadFailed: 'Журнал не загрузился.',
      shownOf: 'показаны последние {shown} из {total}',
      total: 'записей: {total}',
    },

    action: {
      'auth.login': 'Вход',
      'auth.logout': 'Выход',
      'auth.mfa_challenge': 'Запрошен второй фактор',
      'totp.enrollment_started': 'Начата привязка 2FA',
      'totp.enrollment_confirmed': 'Двухфакторка привязана',
      'totp.disabled': 'Двухфакторка отключена',
      'totp.recovery_codes_regenerated': 'Перевыпущены коды восстановления',
      'totp.reset_by_admin': 'Двухфакторка сброшена администратором',
      'user.created': 'Создан пользователь',
      'user.activated': 'Пользователь включён',
      'user.deactivated': 'Пользователь отключён',
      'user.password_reset': 'Сброшен пароль',
      'ssh_config.updated': 'Изменены настройки хоста',
      'ssh_config.tested': 'Проверено подключение',
      'ssh_config.key_replaced': 'Заменён приватный ключ',
      'ssh_config.host_key_learned': 'Запомнен ключ хоста',
      'ssh_config.host_key_mismatch': 'Ключ хоста не совпал',
      'terminal.open': 'Открыт терминал',
      'terminal.close': 'Закрыт терминал',
      'terminal.rejected': 'Терминал не открылся',
    },

    dialog: { cancel: 'Отмена', confirm: 'Подтвердить', done: 'Готово', copy: 'Скопировать' },

    err: {
      unknown: 'Не удалось выполнить запрос.',
      invalid_credentials: 'Неверный логин или пароль.',
      invalid_request: 'Заполните оба поля.',
      account_disabled: 'Учётная запись отключена. Обратитесь к администратору.',
      account_locked: 'Слишком много неудачных попыток. Учётная запись временно заблокирована.',
      account_locked_retry: 'Учётная запись временно заблокирована. Повторите через {minutes} мин.',
      too_many_attempts: 'Слишком много попыток. Повторите позже.',
      unauthenticated: 'Сессия не найдена или истекла.',
      session_expired: 'Сессия истекла, войдите заново.',
      forbidden: 'Недостаточно прав.',
      mfa_challenge_expired: 'Время на подтверждение истекло. Войдите заново.',
      totp_code_invalid: 'Неверный код. Проверьте время на устройстве и попробуйте ещё раз.',
      totp_code_reused: 'Этот код уже использован. Дождитесь следующего.',
      totp_not_enrolled: 'Двухфакторка ещё не привязана.',
      totp_already_enabled: 'Двухфакторка уже привязана.',
      totp_not_started: 'Привязка не начата.',
      totp_not_enabled: 'Второй фактор не включён.',
      totp_required_for_role: 'Для вашей роли второй фактор обязателен — отключить его нельзя.',
      invalid_json: 'Некорректный запрос.',
      internal_error: 'Внутренняя ошибка сервера.',
      payload_too_large: 'Слишком большой запрос.',
      csrf_token_invalid: 'Сессия устарела. Обновите страницу и повторите действие.',
      not_found: 'Запись не найдена — возможно, список устарел. Обновите страницу.',
      id_invalid: 'Некорректный идентификатор записи.',
      username_invalid: 'Логин: 3–32 символа, латиница, цифры, точка, дефис, подчёркивание.',
      username_taken:
        'Такой логин уже занят. Имена не переиспользуются даже после отключения учётной записи.',
      role_invalid: 'Выберите роль.',
      is_active_invalid: 'Некорректное значение состояния.',
      password_required: 'Задайте пароль или включите генерацию.',
      password_too_short: 'Пароль короче 12 символов.',
      password_too_long: 'Пароль длиннее 72 байт — bcrypt отбросил бы остаток.',
      last_admin: 'Это единственный активный администратор. Сначала назначьте другого.',
      host_invalid: 'Некорректный адрес хоста.',
      port_invalid: 'Порт должен быть числом от 1 до 65535.',
      ssh_username_invalid: 'Некорректное имя системного пользователя.',
      private_key_invalid:
        'Не удалось разобрать ключ. Подходит формат OpenSSH (BEGIN OPENSSH PRIVATE KEY) и классический PEM (BEGIN RSA PRIVATE KEY); PKCS#8 (BEGIN PRIVATE KEY) не поддерживается.',
      private_key_type_unsupported: 'Тип ключа не поддерживается: нужен RSA, ed25519 или ecdsa.',
      private_key_missing: 'Файл сохранённого ключа не найден — загрузите ключ заново.',
      passphrase_required: 'Ключ зашифрован — укажите passphrase.',
      passphrase_invalid: 'Passphrase не подходит к этому ключу.',

      ssh_not_configured: 'SSH-хост ещё не настроен администратором.',
      ssh_key_unreadable: 'Не удалось прочитать приватный ключ. Загрузите его заново в админке.',
      ssh_auth_failed: 'Хост отверг ключ. Проверьте SSH-логин и приватный ключ в настройках.',
      ssh_connection_refused: 'Хост отклонил подключение: порт закрыт или сервис не запущен.',
      ssh_host_unresolved: 'Не удалось разрешить имя хоста.',
      ssh_host_unreachable: 'Хост недоступен по сети.',
      ssh_timeout: 'Истекло время ожидания ответа от хоста.',
      ssh_handshake_failed: 'Не удалось согласовать соединение с хостом.',
      ssh_host_key_mismatch:
        'Ключ хоста не совпадает с сохранённым. Подключение прервано — обратитесь к администратору.',
      ssh_pty_failed: 'Хост не выдал терминал (PTY).',
      ssh_error: 'Не удалось установить SSH-соединение.',
      session_limit_user: 'Достигнут предел одновременных сессий для вашей учётной записи.',
      session_limit_total: 'Достигнут общий предел одновременных сессий.',
      idle_timeout: 'Сессия закрыта из-за простоя.',
      message_too_large:
        'Отправленный фрагмент слишком велик — соединение закрыто. Вставляйте текст меньшими частями.',
    },

    errTitle: {
      ssh_not_configured: 'SSH-хост не настроен',
      ssh_key_unreadable: 'Проблема с ключом',
      ssh_auth_failed: 'Хост отверг ключ',
      ssh_host_key_mismatch: 'Ключ хоста не совпал',
      session_limit_user: 'Слишком много сессий',
      session_limit_total: 'Сервер занят',
      idle_timeout: 'Сессия закрыта из-за простоя',
      message_too_large: 'Слишком большой фрагмент',
    },
  },

  /* =============================================================== uk */
  uk: {
    lang: { group: 'Мова', changed: 'Мова: {name}' },
    theme: { group: 'Тема оформлення', changed: 'Тема: {name}' },

    login: {
      pageTitle: 'Вхід — webssh',
      subtitleSignIn: 'Вхід до термінала',
      subtitleVerify: 'Підтвердження входу',
      subtitleEnroll: 'Прив’язка двофакторної автентифікації',
      subtitleRecovery: 'Коди відновлення',
      username: 'Логін',
      password: 'Пароль',
      submit: 'Увійти',
      checking: 'Перевіряємо…',
      fillBoth: 'Заповніть обидва поля.',
      serverUnavailable: 'Сервер недоступний.',
      verifyHint: 'Введіть код із застосунку-автентифікатора або один із кодів відновлення.',
      code: 'Код',
      verifySubmit: 'Підтвердити',
      restart: 'Почати спочатку',
      enrollHint:
        'Для цього облікового запису потрібна двофакторна автентифікація. Додайте секрет до застосунку-автентифікатора й підтвердьте кодом.',
      enrollOpenApp: 'Відкрити в застосунку-автентифікаторі',
      enrollManual: 'Або введіть секрет вручну',
      copySecret: 'Скопіювати секрет',
      enrollCode: 'Код із застосунку',
      enrollSubmit: 'Прив’язати й увійти',
      enrollFailed: 'Не вдалося почати прив’язку.',
      recoveryWarn:
        'Збережіть коди відновлення. Вони показуються один раз і замінюють код із застосунку, якщо пристрій втрачено.',
      copyAll: 'Скопіювати всі',
      recoveryDone: 'Я зберіг коди, продовжити',
      copied: 'Скопійовано',
      copyManually: 'Скопіюйте вручну',
    },

    term: {
      pageTitle: 'Термінал — webssh',
      statusConnecting: 'Підключення…',
      statusConnected: 'Підключено',
      statusClosed: 'Сесію завершено',
      statusDropped: 'З’єднання розірвано',
      statusRetryIn: 'З’єднання розірвано, перепідключення через {seconds} с',
      statusError: 'Помилка з’єднання',
      connectingTitle: 'Підключення…',
      connectingMessage: 'Встановлюємо SSH-з’єднання з хостом.',
      droppedTitle: 'З’єднання розірвано',
      retryIn: 'Повторна спроба через {seconds} с.',
      retryNow: 'Перепідключитися зараз',
      closedTitle: 'Сесію завершено',
      closedMessage: 'Шелл на хості закрито.',
      reopen: 'Відкрити заново',
      loginRequiredTitle: 'Потрібен вхід',
      loginRequiredMessage: 'Сесія завершилася або обліковий запис вимкнено.',
      goToLogin: 'На сторінку входу',
      failedTitle: 'Не вдалося підключитися',
      failedMessage: 'З’єднання закрито сервером. Подробиці можуть бути в журналі адміністратора.',
      retry: 'Спробувати ще раз',
      searchTitle: 'Пошук (Ctrl+Shift+F)',
      searchPlaceholder: 'Пошук у виводі',
      searchPrev: 'Назад',
      searchNext: 'Уперед',
      searchClose: 'Закрити пошук',
      themeTitle: 'Тема оформлення',
      menuTitle: 'Меню',
      adminTitle: 'Адмінка',
      logoutTitle: 'Вийти',
      specialKeys: 'Спеціальні клавіші',
      logTruncated: '# Початок журналу обрізано: збережено останні {count} символів',
    },

    menu: {
      copy: 'Копіювати',
      noSelection: 'нічого не виділено',
      paste: 'Вставити',
      clear: 'Очистити екран',
      reset: 'Скинути термінал',
      find: 'Знайти…',
      fontSize: 'Розмір шрифту',
      smaller: 'Зменшити шрифт',
      larger: 'Збільшити шрифт',
      downloadLog: 'Завантажити журнал сесії',
    },

    toast: {
      copied: 'Скопійовано',
      nothingSelected: 'Нічого не виділено',
      copyNeedsHttps: 'Копіювання недоступне без HTTPS',
      pasteUnavailable: 'Вставлення недоступне: скористайтеся Cmd/Ctrl+V або жестом системи',
      fontSize: 'Розмір шрифту: {size}',
    },

    account: {
      pageTitle: 'Двофакторна автентифікація — webssh',
      title: 'Двофакторна автентифікація',
      stateOn: 'Другий фактор увімкнено.',
      stateOff: 'Другий фактор вимкнено.',
      since: 'Прив’язано {date}.',
      codesLeft: 'Кодів відновлення залишилося: {count}.',
      codesGone: 'Коди закінчилися — перевипустіть їх, інакше втрата телефону означатиме втрату доступу.',
      requiredHint: 'Для вашої ролі другий фактор обов’язковий: наступний вхід почнеться з прив’язки.',
      enable: 'Увімкнути',
      enrollHint: 'Додайте секрет до застосунку-автентифікатора й підтвердьте кодом.',
      confirm: 'Підтвердити',
      cancel: 'Скасувати',
      currentCode: 'Код із застосунку',
      codeHint: 'Підтвердьте, що пристрій при вас',
      codeRequired: 'Введіть код із застосунку.',
      regenerate: 'Перевипустити коди відновлення',
      disable: 'Вимкнути другий фактор',
      disabled: 'Другий фактор вимкнено',
      toTerminal: 'До термінала',
    },

    admin: {
      pageTitle: 'Адміністрування — webssh',
      title: 'Адміністрування',
      checking: 'Перевіряємо доступ…',
      whoami: 'Ви увійшли як {user}',
      onlyAdmins: 'Розділ доступний лише адміністраторам.',
      toTerminal: 'До термінала',
      logout: 'Вийти',
      refresh: 'Оновити',
      sessionStale: 'Сервер недоступний.',
    },

    users: {
      title: 'Користувачі',
      hint: 'Облікові записи вебзастосунку. До SSH-хоста всі вони підключаються під одним і тим самим системним користувачем — з’ясувати, хто саме що зробив, можна лише за журналом нижче.',
      colLogin: 'Логін',
      colRole: 'Роль',
      colCreated: 'Створено',
      colState: 'Стан',
      colActions: 'Дії',
      roleAdmin: 'адміністратор',
      roleUser: 'користувач',
      stateActive: 'активний',
      stateDisabled: 'вимкнений',
      has2fa: '2FA',
      no2fa: 'без 2FA',
      you: 'це ви',
      empty: 'Користувачів немає.',
      loadFailed: 'Список не завантажився.',
      createTitle: 'Створити користувача',
      usernameHint: '3–32 символи: латиниця, цифри, крапка, дефіс, підкреслення',
      roleHint: 'Адміністратору двофакторка обов’язкова',
      passwordPlaceholder: 'не коротше 12 символів',
      generate: 'Згенерувати',
      create: 'Створити',
      resetPassword: 'Скинути пароль',
      reset2fa: 'Скинути 2FA',
      disable: 'Вимкнути',
      enable: 'Увімкнути',
      confirmDisableTitle: 'Вимкнути «{user}»?',
      confirmDisableSelf:
        'Це ваш власний обліковий запис: після вимкнення ви втратите доступ до адмінки. ',
      confirmDisableBody:
        'Обліковий запис залишиться в базі, але увійти під ним буде не можна, а відкриті термінали закриються одразу. Увімкнути назад можна кнопкою поруч.',
      disabledToast: '«{user}» вимкнено',
      disabledToastWithTerminals: '«{user}» вимкнено, терміналів закрито: {count}',
      enabledToast: '«{user}» увімкнено',
      confirmResetTitle: 'Скинути пароль «{user}»?',
      confirmResetSelf:
        'Це ваш власний обліковий запис: після зміни пароля поточна сесія перестане діяти і доведеться увійти знову — вже з новим паролем. ',
      newPasswordSelfMessage:
        'Це пароль вашого облікового запису. Збережіть його зараз: сесія вже недійсна, і після закриття вікна відкриється форма входу.',
      passwordChangedSelfTitle: 'Пароль змінено',
      confirmResetBody:
        'Відкриті вебсесії й термінали цього користувача закриються негайно. Новий пароль показується один раз — відновити його потім немає звідки.',
      newPasswordPlaceholder: 'буде згенеровано',
      passwordTooShort: 'Пароль коротший за {min} символів.',
      newPasswordTitle: 'Новий пароль',
      newPasswordMessage: 'Передайте його користувачу «{user}». Більше він ніде не з’явиться.',
      passwordChanged: 'Пароль «{user}» змінено',
      confirm2faTitle: 'Скинути двофакторку «{user}»?',
      confirm2faBody:
        'Прив’язка й коди відновлення буде видалено. Якщо для цієї ролі другий фактор обов’язковий, наступний вхід почнеться з нової прив’язки.',
      reset2faToast: 'Двофакторку «{user}» скинуто',
      createdTitle: 'Користувача «{user}» створено',
      createdMessage: 'Пароль показується один раз — передайте його й закрийте вікно.',
      createdToast: 'Користувача «{user}» створено',
    },

    ssh: {
      title: 'SSH-хост',
      warn: 'Хост у застосунку один і спільний для всіх. Будь-хто, хто увійшов до вебінтерфейсу, отримує на ньому повноцінний шелл під вказаним нижче системним користувачем і з вказаним ключем — власних облікових даних ніхто не вводить. Зміна адреси або ключа діє одразу й на всіх.',
      address: 'Адреса',
      notConfigured: 'не налаштовано',
      notConfiguredAll: ' — термінал недоступний усім',
      missingKey: ' — бракує ключа',
      key: 'Ключ',
      keyMissing: 'не завантажено',
      unknownType: 'невідомий тип',
      passphrase: 'Passphrase',
      passphraseSet: 'задана',
      passphraseNone: 'немає',
      hostKey: 'Ключ хоста',
      policyTofu: 'запам’ятовується під час першого підключення',
      policyPinned: 'звіряється суворо',
      policyInsecure: 'не перевіряється',
      hostKeyUnknown: 'ключ хоста ще не запам’ятано',
      updated: 'Оновлено',
      editTitle: 'Змінити',
      host: 'Хост',
      port: 'Порт',
      sshUser: 'Користувач SSH',
      privateKey: 'Приватний ключ',
      keyHint:
        'Залиште порожнім — збережений ключ не зміниться. Підходить формат OpenSSH і класичний PEM; PKCS#8 (BEGIN PRIVATE KEY) бібліотека ssh2 не читає. Ключ ніколи не показується назад — замінити можна, подивитися ні.',
      passphraseLabel: 'Passphrase ключа',
      passphrasePlaceholder: 'не змінювати',
      clearPassphrase: 'Прибрати збережену passphrase',
      save: 'Зберегти',
      resetForm: 'Скинути форму',
      confirmTitle: 'Змінити налаштування хоста?',
      consequenceKey:
        'Збережений приватний ключ буде замінено безповоротно — попередній ніде не зберігається і відновити його звідси не можна.',
      consequenceHostKey:
        'Адреса змінюється, тому запам’ятований ключ хоста буде скинуто: ключ нового сервера прийметься під час першого підключення без звірки.',
      consequencePassphrase: 'Збережену passphrase буде видалено.',
      affectsAll: 'Зміна одразу вплине на всіх користувачів застосунку.',
      saved: 'Налаштування хоста збережено',
      test: 'Перевірити підключення',
      testing: 'Перевіряємо підключення…',
      testOk: 'Підключення пройшло: хост прийняв ключ.',
      testOkLearned: 'Підключення пройшло, ключ хоста запам’ятано: {fingerprint}',
      testFailed: 'Підключитися не вдалося.',
      testPresented: 'Хост пред’явив {fingerprint}.',
      'hint.loopback_in_container':
        'Адреса петльова, а застосунок працює в контейнері: усередині нього 127.0.0.1 і localhost вказують на сам контейнер, а не на машину. Перевірка з консолі сервера цього не показує. Вкажіть адресу машини в мережі (або адресу шлюзу docker), а не петльову.',
      keyLoaded: 'Ключ завантажено з «{file}»',
      notAKey: 'Не схоже на приватний ключ — перевірте, чи не обрано публічний (.pub).',
      tooLarge: 'Файл завеликий для приватного ключа.',
      readFailed: 'Не вдалося прочитати файл.',
      portInvalid: 'Порт має бути числом від 1 до 65535.',
    },

    audit: {
      title: 'Журнал',
      hint: 'Останні 100 записів, нові згори. Вміст термінала не записується — лише факти входу, дій адміністратора та відкриття/закриття SSH-сесій.',
      colTime: 'Час',
      colAction: 'Дія',
      colActor: 'Хто',
      colOutcome: 'Підсумок',
      colTarget: 'Об’єкт',
      colIp: 'Адреса',
      colDetail: 'Подробиці',
      success: 'успіх',
      failure: 'відмова',
      empty: 'Журнал порожній.',
      loadFailed: 'Журнал не завантажився.',
      shownOf: 'показано останні {shown} із {total}',
      total: 'записів: {total}',
    },

    action: {
      'auth.login': 'Вхід',
      'auth.logout': 'Вихід',
      'auth.mfa_challenge': 'Запитано другий фактор',
      'totp.enrollment_started': 'Розпочато прив’язку 2FA',
      'totp.enrollment_confirmed': 'Двофакторку прив’язано',
      'totp.disabled': 'Двофакторку вимкнено',
      'totp.recovery_codes_regenerated': 'Перевипущено коди відновлення',
      'totp.reset_by_admin': 'Двофакторку скинуто адміністратором',
      'user.created': 'Створено користувача',
      'user.activated': 'Користувача увімкнено',
      'user.deactivated': 'Користувача вимкнено',
      'user.password_reset': 'Скинуто пароль',
      'ssh_config.updated': 'Змінено налаштування хоста',
      'ssh_config.tested': 'Перевірено підключення',
      'ssh_config.key_replaced': 'Замінено приватний ключ',
      'ssh_config.host_key_learned': 'Запам’ятано ключ хоста',
      'ssh_config.host_key_mismatch': 'Ключ хоста не збігся',
      'terminal.open': 'Відкрито термінал',
      'terminal.close': 'Закрито термінал',
      'terminal.rejected': 'Термінал не відкрився',
    },

    dialog: { cancel: 'Скасувати', confirm: 'Підтвердити', done: 'Готово', copy: 'Скопіювати' },

    err: {
      unknown: 'Не вдалося виконати запит.',
      invalid_credentials: 'Невірний логін або пароль.',
      invalid_request: 'Заповніть обидва поля.',
      account_disabled: 'Обліковий запис вимкнено. Зверніться до адміністратора.',
      account_locked: 'Забагато невдалих спроб. Обліковий запис тимчасово заблоковано.',
      account_locked_retry: 'Обліковий запис тимчасово заблоковано. Повторіть через {minutes} хв.',
      too_many_attempts: 'Забагато спроб. Повторіть пізніше.',
      unauthenticated: 'Сесію не знайдено або вона завершилася.',
      session_expired: 'Сесія завершилася, увійдіть знову.',
      forbidden: 'Недостатньо прав.',
      mfa_challenge_expired: 'Час на підтвердження вичерпано. Увійдіть знову.',
      totp_code_invalid: 'Невірний код. Перевірте час на пристрої й спробуйте ще раз.',
      totp_code_reused: 'Цей код уже використано. Дочекайтеся наступного.',
      totp_not_enrolled: 'Двофакторку ще не прив’язано.',
      totp_already_enabled: 'Двофакторку вже прив’язано.',
      totp_not_started: 'Прив’язку не розпочато.',
      totp_not_enabled: 'Другий фактор не увімкнено.',
      totp_required_for_role: 'Для вашої ролі другий фактор обов’язковий — вимкнути його не можна.',
      invalid_json: 'Некоректний запит.',
      internal_error: 'Внутрішня помилка сервера.',
      payload_too_large: 'Завеликий запит.',
      csrf_token_invalid: 'Сесія застаріла. Оновіть сторінку й повторіть дію.',
      not_found: 'Запис не знайдено — можливо, список застарів. Оновіть сторінку.',
      id_invalid: 'Некоректний ідентифікатор запису.',
      username_invalid: 'Логін: 3–32 символи, латиниця, цифри, крапка, дефіс, підкреслення.',
      username_taken:
        'Такий логін уже зайнято. Імена не використовуються повторно навіть після вимкнення облікового запису.',
      role_invalid: 'Оберіть роль.',
      is_active_invalid: 'Некоректне значення стану.',
      password_required: 'Задайте пароль або увімкніть генерацію.',
      password_too_short: 'Пароль коротший за 12 символів.',
      password_too_long: 'Пароль довший за 72 байти — bcrypt відкинув би решту.',
      last_admin: 'Це єдиний активний адміністратор. Спершу призначте іншого.',
      host_invalid: 'Некоректна адреса хоста.',
      port_invalid: 'Порт має бути числом від 1 до 65535.',
      ssh_username_invalid: 'Некоректне ім’я системного користувача.',
      private_key_invalid:
        'Не вдалося розібрати ключ. Підходить формат OpenSSH (BEGIN OPENSSH PRIVATE KEY) і класичний PEM (BEGIN RSA PRIVATE KEY); PKCS#8 (BEGIN PRIVATE KEY) не підтримується.',
      private_key_type_unsupported: 'Тип ключа не підтримується: потрібен RSA, ed25519 або ecdsa.',
      private_key_missing: 'Файл збереженого ключа не знайдено — завантажте ключ заново.',
      passphrase_required: 'Ключ зашифровано — вкажіть passphrase.',
      passphrase_invalid: 'Passphrase не підходить до цього ключа.',

      ssh_not_configured: 'SSH-хост ще не налаштовано адміністратором.',
      ssh_key_unreadable: 'Не вдалося прочитати приватний ключ. Завантажте його заново в адмінці.',
      ssh_auth_failed: 'Хост відхилив ключ. Перевірте SSH-логін і приватний ключ у налаштуваннях.',
      ssh_connection_refused: 'Хост відхилив підключення: порт закрито або сервіс не запущено.',
      ssh_host_unresolved: 'Не вдалося розв’язати ім’я хоста.',
      ssh_host_unreachable: 'Хост недоступний через мережу.',
      ssh_timeout: 'Вичерпано час очікування відповіді від хоста.',
      ssh_handshake_failed: 'Не вдалося узгодити з’єднання з хостом.',
      ssh_host_key_mismatch:
        'Ключ хоста не збігається зі збереженим. Підключення перервано — зверніться до адміністратора.',
      ssh_pty_failed: 'Хост не видав термінал (PTY).',
      ssh_error: 'Не вдалося встановити SSH-з’єднання.',
      session_limit_user: 'Досягнуто межі одночасних сесій для вашого облікового запису.',
      session_limit_total: 'Досягнуто загальної межі одночасних сесій.',
      idle_timeout: 'Сесію закрито через простій.',
      message_too_large:
        'Надісланий фрагмент завеликий — з’єднання закрито. Вставляйте текст меншими частинами.',
    },

    errTitle: {
      ssh_not_configured: 'SSH-хост не налаштовано',
      ssh_key_unreadable: 'Проблема з ключем',
      ssh_auth_failed: 'Хост відхилив ключ',
      ssh_host_key_mismatch: 'Ключ хоста не збігся',
      session_limit_user: 'Забагато сесій',
      session_limit_total: 'Сервер зайнятий',
      idle_timeout: 'Сесію закрито через простій',
      message_too_large: 'Завеликий фрагмент',
    },
  },

  /* =============================================================== en */
  en: {
    lang: { group: 'Language', changed: 'Language: {name}' },
    theme: { group: 'Theme', changed: 'Theme: {name}' },

    login: {
      pageTitle: 'Sign in — webssh',
      subtitleSignIn: 'Sign in to the terminal',
      subtitleVerify: 'Confirm sign-in',
      subtitleEnroll: 'Set up two-factor authentication',
      subtitleRecovery: 'Recovery codes',
      username: 'Username',
      password: 'Password',
      submit: 'Sign in',
      checking: 'Checking…',
      fillBoth: 'Fill in both fields.',
      serverUnavailable: 'Server unavailable.',
      verifyHint: 'Enter the code from your authenticator app or one of your recovery codes.',
      code: 'Code',
      verifySubmit: 'Confirm',
      restart: 'Start over',
      enrollHint:
        'This account requires two-factor authentication. Add the secret to your authenticator app and confirm with a code.',
      enrollOpenApp: 'Open in authenticator app',
      enrollManual: 'Or enter the secret manually',
      copySecret: 'Copy secret',
      enrollCode: 'Code from the app',
      enrollSubmit: 'Enrol and sign in',
      enrollFailed: 'Could not start enrolment.',
      recoveryWarn:
        'Save your recovery codes. They are shown once and replace the app code if you lose your device.',
      copyAll: 'Copy all',
      recoveryDone: 'I saved the codes, continue',
      copied: 'Copied',
      copyManually: 'Copy manually',
    },

    term: {
      pageTitle: 'Terminal — webssh',
      statusConnecting: 'Connecting…',
      statusConnected: 'Connected',
      statusClosed: 'Session ended',
      statusDropped: 'Connection lost',
      statusRetryIn: 'Connection lost, reconnecting in {seconds}s',
      statusError: 'Connection error',
      connectingTitle: 'Connecting…',
      connectingMessage: 'Establishing the SSH connection to the host.',
      droppedTitle: 'Connection lost',
      retryIn: 'Retrying in {seconds}s.',
      retryNow: 'Reconnect now',
      closedTitle: 'Session ended',
      closedMessage: 'The shell on the host was closed.',
      reopen: 'Open again',
      loginRequiredTitle: 'Sign-in required',
      loginRequiredMessage: 'The session expired or the account was disabled.',
      goToLogin: 'Go to sign-in',
      failedTitle: 'Could not connect',
      failedMessage: 'The server closed the connection. Details may be in the admin audit log.',
      retry: 'Try again',
      searchTitle: 'Search (Ctrl+Shift+F)',
      searchPlaceholder: 'Search output',
      searchPrev: 'Previous',
      searchNext: 'Next',
      searchClose: 'Close search',
      themeTitle: 'Theme',
      menuTitle: 'Menu',
      adminTitle: 'Admin',
      logoutTitle: 'Sign out',
      specialKeys: 'Special keys',
      logTruncated: '# Beginning of the log was trimmed: last {count} characters kept',
    },

    menu: {
      copy: 'Copy',
      noSelection: 'nothing selected',
      paste: 'Paste',
      clear: 'Clear screen',
      reset: 'Reset terminal',
      find: 'Find…',
      fontSize: 'Font size',
      smaller: 'Decrease font size',
      larger: 'Increase font size',
      downloadLog: 'Download session log',
    },

    toast: {
      copied: 'Copied',
      nothingSelected: 'Nothing selected',
      copyNeedsHttps: 'Copying requires HTTPS',
      pasteUnavailable: 'Paste unavailable: use Cmd/Ctrl+V or the system gesture',
      fontSize: 'Font size: {size}',
    },

    account: {
      pageTitle: 'Two-factor authentication — webssh',
      title: 'Two-factor authentication',
      stateOn: 'Two-factor is on.',
      stateOff: 'Two-factor is off.',
      since: 'Enrolled on {date}.',
      codesLeft: 'Recovery codes left: {count}.',
      codesGone: 'You are out of codes — reissue them, or losing your phone means losing access.',
      requiredHint: 'Your role requires a second factor: the next sign-in will start with enrolment.',
      enable: 'Turn on',
      enrollHint: 'Add the secret to your authenticator app and confirm with a code.',
      confirm: 'Confirm',
      cancel: 'Cancel',
      currentCode: 'Code from the app',
      codeHint: 'Confirm that you have your device with you',
      codeRequired: 'Enter the code from the app.',
      regenerate: 'Reissue recovery codes',
      disable: 'Turn off two-factor',
      disabled: 'Two-factor turned off',
      toTerminal: 'To terminal',
    },

    admin: {
      pageTitle: 'Administration — webssh',
      title: 'Administration',
      checking: 'Checking access…',
      whoami: 'Signed in as {user}',
      onlyAdmins: 'This section is for administrators only.',
      toTerminal: 'To terminal',
      logout: 'Sign out',
      refresh: 'Refresh',
      sessionStale: 'Server unavailable.',
    },

    users: {
      title: 'Users',
      hint: 'Web application accounts. They all connect to the SSH host as the same system user — the only way to tell who did what is the audit log below.',
      colLogin: 'Username',
      colRole: 'Role',
      colCreated: 'Created',
      colState: 'State',
      colActions: 'Actions',
      roleAdmin: 'administrator',
      roleUser: 'user',
      stateActive: 'active',
      stateDisabled: 'disabled',
      has2fa: '2FA',
      no2fa: 'no 2FA',
      you: 'you',
      empty: 'No users.',
      loadFailed: 'Could not load the list.',
      createTitle: 'Create user',
      usernameHint: '3–32 characters: letters, digits, dot, hyphen, underscore',
      roleHint: 'Two-factor is mandatory for administrators',
      passwordPlaceholder: 'at least 12 characters',
      generate: 'Generate',
      create: 'Create',
      resetPassword: 'Reset password',
      reset2fa: 'Reset 2FA',
      disable: 'Disable',
      enable: 'Enable',
      confirmDisableTitle: 'Disable “{user}”?',
      confirmDisableSelf: 'This is your own account: after disabling it you will lose admin access. ',
      confirmDisableBody:
        'The account stays in the database but can no longer sign in, and open terminals close immediately. You can re-enable it with the button next to it.',
      disabledToast: '“{user}” disabled',
      disabledToastWithTerminals: '“{user}” disabled, terminals closed: {count}',
      enabledToast: '“{user}” enabled',
      confirmResetTitle: 'Reset the password for “{user}”?',
      confirmResetSelf:
        'This is your own account: changing the password invalidates your current session, and you will have to sign in again with the new password. ',
      newPasswordSelfMessage:
        'This is your own account password. Save it now: your session is already invalid, and closing this window takes you to the sign-in form.',
      passwordChangedSelfTitle: 'Password changed',
      confirmResetBody:
        'Open web sessions and terminals for this user close immediately. The new password is shown once — there is no way to recover it afterwards.',
      newPasswordPlaceholder: 'will be generated',
      passwordTooShort: 'Password is shorter than {min} characters.',
      newPasswordTitle: 'New password',
      newPasswordMessage: 'Hand it to “{user}”. It will not appear anywhere again.',
      passwordChanged: 'Password for “{user}” changed',
      confirm2faTitle: 'Reset two-factor for “{user}”?',
      confirm2faBody:
        'The enrolment and recovery codes will be deleted. If the second factor is mandatory for this role, the next sign-in starts with a new enrolment.',
      reset2faToast: 'Two-factor for “{user}” reset',
      createdTitle: 'User “{user}” created',
      createdMessage: 'The password is shown once — hand it over and close this window.',
      createdToast: 'User “{user}” created',
    },

    ssh: {
      title: 'SSH host',
      warn: 'There is a single host shared by everyone. Anyone who signs in to the web interface gets a full shell on it as the system user below, using the key below — nobody enters their own credentials. Changing the address or the key takes effect immediately for everyone.',
      address: 'Address',
      notConfigured: 'not configured',
      notConfiguredAll: ' — the terminal is unavailable to everyone',
      missingKey: ' — the key is missing',
      key: 'Key',
      keyMissing: 'not uploaded',
      unknownType: 'unknown type',
      passphrase: 'Passphrase',
      passphraseSet: 'set',
      passphraseNone: 'none',
      hostKey: 'Host key',
      policyTofu: 'remembered on first connection',
      policyPinned: 'checked strictly',
      policyInsecure: 'not checked',
      hostKeyUnknown: 'host key not remembered yet',
      updated: 'Updated',
      editTitle: 'Edit',
      host: 'Host',
      port: 'Port',
      sshUser: 'SSH user',
      privateKey: 'Private key',
      keyHint:
        'Leave empty to keep the stored key. OpenSSH format and classic PEM work; PKCS#8 (BEGIN PRIVATE KEY) is not readable by ssh2. The key is never shown back — it can be replaced, not viewed.',
      passphraseLabel: 'Key passphrase',
      passphrasePlaceholder: 'leave unchanged',
      clearPassphrase: 'Remove the stored passphrase',
      save: 'Save',
      resetForm: 'Reset form',
      confirmTitle: 'Change the host settings?',
      consequenceKey:
        'The stored private key will be replaced irreversibly — the previous one is kept nowhere and cannot be recovered from here.',
      consequenceHostKey:
        'The address is changing, so the remembered host key will be cleared: the new server’s key will be accepted on first connection without verification.',
      consequencePassphrase: 'The stored passphrase will be deleted.',
      affectsAll: 'The change affects every user of the application at once.',
      saved: 'Host settings saved',
      test: 'Test connection',
      testing: 'Testing the connection…',
      testOk: 'Connected: the host accepted the key.',
      testOkLearned: 'Connected, host key remembered: {fingerprint}',
      testFailed: 'Could not connect.',
      testPresented: 'The host presented {fingerprint}.',
      'hint.loopback_in_container':
        'The address is a loopback one, but the application runs in a container: inside it 127.0.0.1 and localhost point at the container itself, not at the machine. Testing from the server console does not reveal this. Use the machine address on the network (or the docker gateway address) instead of a loopback one.',
      keyLoaded: 'Key loaded from “{file}”',
      notAKey: 'This does not look like a private key — check you did not pick the public one (.pub).',
      tooLarge: 'The file is too large for a private key.',
      readFailed: 'Could not read the file.',
      portInvalid: 'The port must be a number between 1 and 65535.',
    },

    audit: {
      title: 'Audit log',
      hint: 'The last 100 entries, newest first. Terminal contents are not recorded — only sign-ins, administrator actions and SSH session open/close events.',
      colTime: 'Time',
      colAction: 'Action',
      colActor: 'Who',
      colOutcome: 'Result',
      colTarget: 'Target',
      colIp: 'Address',
      colDetail: 'Details',
      success: 'success',
      failure: 'failure',
      empty: 'The log is empty.',
      loadFailed: 'Could not load the log.',
      shownOf: 'showing the last {shown} of {total}',
      total: 'entries: {total}',
    },

    action: {
      'auth.login': 'Sign-in',
      'auth.logout': 'Sign-out',
      'auth.mfa_challenge': 'Second factor requested',
      'totp.enrollment_started': '2FA enrolment started',
      'totp.enrollment_confirmed': 'Two-factor enrolled',
      'totp.disabled': 'Two-factor disabled',
      'totp.recovery_codes_regenerated': 'Recovery codes reissued',
      'totp.reset_by_admin': 'Two-factor reset by administrator',
      'user.created': 'User created',
      'user.activated': 'User enabled',
      'user.deactivated': 'User disabled',
      'user.password_reset': 'Password reset',
      'ssh_config.updated': 'Host settings changed',
      'ssh_config.tested': 'Connection tested',
      'ssh_config.key_replaced': 'Private key replaced',
      'ssh_config.host_key_learned': 'Host key remembered',
      'ssh_config.host_key_mismatch': 'Host key mismatch',
      'terminal.open': 'Terminal opened',
      'terminal.close': 'Terminal closed',
      'terminal.rejected': 'Terminal refused',
    },

    dialog: { cancel: 'Cancel', confirm: 'Confirm', done: 'Done', copy: 'Copy' },

    err: {
      unknown: 'The request failed.',
      invalid_credentials: 'Wrong username or password.',
      invalid_request: 'Fill in both fields.',
      account_disabled: 'The account is disabled. Contact an administrator.',
      account_locked: 'Too many failed attempts. The account is temporarily locked.',
      account_locked_retry: 'The account is temporarily locked. Try again in {minutes} min.',
      too_many_attempts: 'Too many attempts. Try again later.',
      unauthenticated: 'Session not found or expired.',
      session_expired: 'The session expired, sign in again.',
      forbidden: 'Not enough permissions.',
      mfa_challenge_expired: 'The confirmation window expired. Sign in again.',
      totp_code_invalid: 'Wrong code. Check the clock on your device and try again.',
      totp_code_reused: 'That code was already used. Wait for the next one.',
      totp_not_enrolled: 'Two-factor is not enrolled yet.',
      totp_already_enabled: 'Two-factor is already enrolled.',
      totp_not_started: 'Enrolment has not been started.',
      totp_not_enabled: 'Two-factor is not enabled.',
      totp_required_for_role: 'Your role requires a second factor — it cannot be turned off.',
      invalid_json: 'Malformed request.',
      internal_error: 'Internal server error.',
      payload_too_large: 'The request is too large.',
      csrf_token_invalid: 'The session is stale. Reload the page and repeat the action.',
      not_found: 'Record not found — the list may be out of date. Reload the page.',
      id_invalid: 'Invalid record identifier.',
      username_invalid: 'Username: 3–32 characters, letters, digits, dot, hyphen, underscore.',
      username_taken:
        'That username is taken. Names are never reused, even after an account is disabled.',
      role_invalid: 'Choose a role.',
      is_active_invalid: 'Invalid state value.',
      password_required: 'Set a password or turn on generation.',
      password_too_short: 'The password is shorter than 12 characters.',
      password_too_long: 'The password is longer than 72 bytes — bcrypt would discard the rest.',
      last_admin: 'This is the only active administrator. Appoint another one first.',
      host_invalid: 'Invalid host address.',
      port_invalid: 'The port must be a number between 1 and 65535.',
      ssh_username_invalid: 'Invalid system user name.',
      private_key_invalid:
        'Could not parse the key. OpenSSH format (BEGIN OPENSSH PRIVATE KEY) and classic PEM (BEGIN RSA PRIVATE KEY) work; PKCS#8 (BEGIN PRIVATE KEY) is not supported.',
      private_key_type_unsupported: 'Unsupported key type: RSA, ed25519 or ecdsa is required.',
      private_key_missing: 'The stored key file is missing — upload the key again.',
      passphrase_required: 'The key is encrypted — provide the passphrase.',
      passphrase_invalid: 'The passphrase does not match this key.',

      ssh_not_configured: 'The SSH host has not been configured by an administrator yet.',
      ssh_key_unreadable: 'Could not read the private key. Upload it again in the admin panel.',
      ssh_auth_failed: 'The host rejected the key. Check the SSH user and the private key in settings.',
      ssh_connection_refused: 'The host refused the connection: the port is closed or the service is down.',
      ssh_host_unresolved: 'Could not resolve the host name.',
      ssh_host_unreachable: 'The host is unreachable over the network.',
      ssh_timeout: 'Timed out waiting for the host.',
      ssh_handshake_failed: 'Could not negotiate the connection with the host.',
      ssh_host_key_mismatch:
        'The host key does not match the stored one. The connection was aborted — contact an administrator.',
      ssh_pty_failed: 'The host did not grant a terminal (PTY).',
      ssh_error: 'Could not establish the SSH connection.',
      session_limit_user: 'You have reached the limit of concurrent sessions for your account.',
      session_limit_total: 'The overall limit of concurrent sessions has been reached.',
      idle_timeout: 'The session was closed after being idle.',
      message_too_large:
        'The chunk you sent was too large — the connection was closed. Paste text in smaller pieces.',
    },

    errTitle: {
      ssh_not_configured: 'SSH host not configured',
      ssh_key_unreadable: 'Key problem',
      ssh_auth_failed: 'Host rejected the key',
      ssh_host_key_mismatch: 'Host key mismatch',
      session_limit_user: 'Too many sessions',
      session_limit_total: 'Server busy',
      idle_timeout: 'Session closed after being idle',
      message_too_large: 'Chunk too large',
    },
  },
};

/* --------------------------------------------------------- состояние */

const listeners = new Set();
let current = 'en';

/**
 * Язык по умолчанию берётся у браузера. Порядок navigator.languages —
 * это заявленные предпочтения человека, поэтому первый поддерживаемый из
 * списка честнее, чем первый попавшийся.
 */
function detect() {
  const preferred = navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language || 'en'];

  for (const tag of preferred) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (LANGS[base]) return base;
  }
  return 'en';
}

function readStored() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && LANGS[stored]) return stored;
  } catch {
    // localStorage бывает недоступен: приватный режим, отключённые cookie.
  }
  return detect();
}

function lookup(lang, key) {
  let node = DICT[lang];
  const parts = key.split('.');

  for (let i = 0; i < parts.length; i += 1) {
    if (!node || typeof node !== 'object') return undefined;

    /*
     * Часть ключей содержит точку внутри имени, а не как разделитель
     * уровней: коды действий журнала — это 'auth.login', 'ssh_config.updated'
     * и подобные, и они лежат в словаре целыми строками. Поэтому на каждом
     * шаге сначала пробуем весь остаток как одно имя и только потом
     * спускаемся глубже. Без этого 'action.auth.login' искался бы как
     * action → auth → login и не находился никогда.
     */
    const rest = parts.slice(i).join('.');
    if (typeof node[rest] === 'string') return node[rest];

    node = node[parts[i]];
  }

  return typeof node === 'string' ? node : undefined;
}

/**
 * @param {string} key ключ вида 'users.colLogin'
 * @param {object} [vars] подстановки для {name}
 */
export function t(key, vars) {
  // Запасной путь — английский, затем сам ключ: увидеть 'users.colLogin'
  // на экране неприятно, но это сразу показывает, чего не хватает, в
  // отличие от пустой строки.
  const template = lookup(current, key) ?? lookup('en', key) ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

/** Есть ли перевод — чтобы отличить «нет ключа» от «ключ равен себе». */
export function has(key) {
  return lookup(current, key) !== undefined || lookup('en', key) !== undefined;
}

export function getLang() {
  return current;
}

export function setLang(lang) {
  if (!LANGS[lang] || lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Не сохранилось — язык просто не переживёт перезагрузку.
  }
  applyStatic();
  for (const listener of listeners) listener(lang);
}

/** @param {(lang: string) => void} listener */
export function onLangChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Переводит статическую разметку: текст узлов с data-i18n и атрибуты,
 * перечисленные в data-i18n-attr вида "placeholder:login.username".
 * Вызывается при загрузке и при каждой смене языка.
 */
export function applyStatic(root = document) {
  const scope = root === document ? document.documentElement : root;

  for (const node of scope.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }

  for (const node of scope.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of node.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((part) => part.trim());
      if (attr && key) node.setAttribute(attr, t(key));
    }
  }

  if (root === document) {
    document.documentElement.lang = LANGS[current].htmlLang;
    const title = document.querySelector('title[data-i18n]');
    if (title) document.title = t(title.dataset.i18n);
  }
}

/** Применяет сохранённый язык. Вызывается как можно раньше на каждой странице. */
export function initI18n() {
  current = readStored();
  // Разметки в этот момент ещё может не быть — перевод статики делает
  // вызывающий код после построения DOM.
  document.documentElement.lang = LANGS[current].htmlLang;
  return current;
}

/** Локаль для Intl: даты и числа должны следовать выбранному языку. */
export function locale() {
  return { ru: 'ru-RU', uk: 'uk-UA', en: 'en-GB' }[current] || 'en-GB';
}
