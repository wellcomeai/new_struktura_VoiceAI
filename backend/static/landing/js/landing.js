/* ============================================================================
   VOICYFY LANDING PAGE v3.0 — JavaScript
   Auth, Modals, Scroll animations, FAQ, Referral tracking
   ============================================================================ */

(function () {
  'use strict';

  /* ---- API Client ---- */
  const api = {
    baseUrl: '/api',
    async request(endpoint, options = {}) {
      const token = localStorage.getItem('auth_token');
      const headers = { ...options.headers };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      if (options.body && typeof options.body !== 'string') {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
      }
      const res = await fetch(this.baseUrl + endpoint, { ...options, headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.message || 'API Error');
      return data;
    },
    register(d)     { return this.request('/auth/register', { method: 'POST', body: d }); },
    login(d)        { return this.request('/auth/login', { method: 'POST', body: d }); },
    verifyEmail(d)  { return this.request('/email-verification/verify', { method: 'POST', body: d }); },
    resendCode(d)   { return this.request('/email-verification/resend', { method: 'POST', body: d }); }
  };

  /* ---- Redirect if already logged in ---- */
  if (localStorage.getItem('auth_token')) {
    window.location.href = '/static/dashboard.html';
    return;
  }

  /* ---- Referral Tracker ---- */
  (function trackReferral() {
    const p = new URLSearchParams(window.location.search);
    const utm = {
      utm_source: p.get('utm_source'),
      utm_medium: p.get('utm_medium'),
      utm_campaign: p.get('utm_campaign'),
      utm_content: p.get('utm_content'),
      utm_term: p.get('utm_term')
    };
    if (utm.utm_campaign && utm.utm_source === 'partner') {
      localStorage.setItem('referral_code', utm.utm_campaign);
      localStorage.setItem('utm_data', JSON.stringify(utm));
    }
    // Pre-fill referral code if stored
    const stored = localStorage.getItem('referral_code');
    if (stored) {
      const el = document.getElementById('regReferral');
      if (el) el.value = stored;
    }
  })();

  /* ======================================================================
     MODAL SYSTEM
     ====================================================================== */
  const modals = {
    login: document.getElementById('loginModal'),
    register: document.getElementById('registerModal'),
    verification: document.getElementById('verificationModal')
  };

  function openModal(name) {
    closeMobileMenu();
    Object.values(modals).forEach(m => m.classList.remove('open'));
    if (modals[name]) {
      modals[name].classList.add('open');
      document.body.style.overflow = 'hidden';
      // Focus first input
      const input = modals[name].querySelector('input');
      if (input) setTimeout(() => input.focus(), 100);
    }
  }

  function closeAllModals() {
    Object.values(modals).forEach(m => m.classList.remove('open'));
    document.body.style.overflow = '';
  }

  // Close on backdrop click
  document.querySelectorAll('.modal__backdrop').forEach(el => {
    el.addEventListener('click', closeAllModals);
  });
  // Close buttons
  document.querySelectorAll('.modal__close').forEach(el => {
    el.addEventListener('click', closeAllModals);
  });
  // ESC key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAllModals();
  });

  // Modal openers
  document.getElementById('btnLogin')?.addEventListener('click', () => openModal('login'));
  document.getElementById('btnRegister')?.addEventListener('click', () => openModal('register'));
  document.getElementById('btnLoginMobile')?.addEventListener('click', () => openModal('login'));
  document.getElementById('btnRegisterMobile')?.addEventListener('click', () => openModal('register'));
  document.getElementById('footerLogin')?.addEventListener('click', e => { e.preventDefault(); openModal('login'); });
  document.getElementById('footerRegister')?.addEventListener('click', e => { e.preventDefault(); openModal('register'); });
  document.getElementById('switchToRegister')?.addEventListener('click', e => { e.preventDefault(); openModal('register'); });
  document.getElementById('switchToLogin')?.addEventListener('click', e => { e.preventDefault(); openModal('login'); });

  // All buttons with data-action="register"
  document.querySelectorAll('[data-action="register"]').forEach(btn => {
    btn.addEventListener('click', () => openModal('register'));
  });

  /* ======================================================================
     NOTIFICATION HELPER
     ====================================================================== */
  function showNotification(containerId, type, message) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.className = 'auth-form__notification show ' + type;
    el.textContent = message;
  }
  function clearNotification(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.className = 'auth-form__notification';
    el.textContent = '';
  }

  /* ======================================================================
     LOGIN FORM
     ====================================================================== */
  document.getElementById('loginForm')?.addEventListener('submit', async function (e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const btn = document.getElementById('loginSubmit');

    if (!email || !password) {
      showNotification('loginNotification', 'error', 'Заполните все поля');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Вход...';
    clearNotification('loginNotification');

    try {
      const res = await api.login({ email, password });
      const token = res.token || res.access_token || (res.data && res.data.token);
      if (token) {
        localStorage.setItem('auth_token', token);
        showNotification('loginNotification', 'success', 'Успешный вход!');
        setTimeout(() => { window.location.href = '/static/dashboard.html'; }, 400);
      } else {
        throw new Error('Не удалось получить токен');
      }
    } catch (err) {
      showNotification('loginNotification', 'error', err.message || 'Ошибка входа');
      btn.disabled = false;
      btn.textContent = 'Войти';
    }
  });

  /* ======================================================================
     REGISTER FORM
     ====================================================================== */
  let registeredEmail = '';

  document.getElementById('registerForm')?.addEventListener('submit', async function (e) {
    e.preventDefault();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const referral = document.getElementById('regReferral').value.trim();
    const btn = document.getElementById('registerSubmit');

    if (!email || !password) {
      showNotification('registerNotification', 'error', 'Заполните все обязательные поля');
      return;
    }
    if (password.length < 8) {
      showNotification('registerNotification', 'error', 'Пароль должен быть не менее 8 символов');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Регистрация...';
    clearNotification('registerNotification');

    const body = { email, password };
    if (referral) body.referral_code = referral;
    const utmStored = localStorage.getItem('utm_data');
    if (utmStored) {
      try { body.utm_data = JSON.parse(utmStored); } catch (_) {}
    }

    try {
      const res = await api.register(body);
      // Clear referral data after successful registration
      localStorage.removeItem('referral_code');
      localStorage.removeItem('utm_data');

      registeredEmail = email;

      if (res.verification_required || res.verification_sent) {
        // Need email verification
        document.getElementById('verificationEmail').textContent = email;
        openModal('verification');
        startResendTimer();
        resetVerification();
      } else {
        // Direct login (no verification needed)
        const token = res.token || res.access_token || (res.data && res.data.token);
        if (token) {
          localStorage.setItem('auth_token', token);
          window.location.href = '/static/dashboard.html';
        }
      }
    } catch (err) {
      showNotification('registerNotification', 'error', err.message || 'Ошибка регистрации');
      btn.disabled = false;
      btn.textContent = 'Создать аккаунт';
    }
  });

  /* ======================================================================
     EMAIL VERIFICATION
     ====================================================================== */
  let verAttempts = 3;
  let resendTimerId = null;
  let resendSeconds = 0;

  function resetVerification() {
    verAttempts = 3;
    document.getElementById('verAttempts').textContent = 'Осталось попыток: 3';
    document.getElementById('verCode').value = '';
    document.getElementById('verCode').disabled = false;
    document.getElementById('verifySubmit').disabled = false;
    clearNotification('verificationNotification');
  }

  function startResendTimer() {
    resendSeconds = 60;
    const btn = document.getElementById('resendCode');
    const timer = document.getElementById('resendTimer');
    btn.disabled = true;
    if (resendTimerId) clearInterval(resendTimerId);
    resendTimerId = setInterval(() => {
      resendSeconds--;
      if (resendSeconds <= 0) {
        clearInterval(resendTimerId);
        resendTimerId = null;
        btn.disabled = false;
        timer.textContent = '';
      } else {
        timer.textContent = '(' + resendSeconds + 'с)';
      }
    }, 1000);
    timer.textContent = '(60с)';
  }

  document.getElementById('verificationForm')?.addEventListener('submit', async function (e) {
    e.preventDefault();
    const code = document.getElementById('verCode').value.trim();
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      showNotification('verificationNotification', 'error', 'Введите 6-значный код');
      return;
    }

    const btn = document.getElementById('verifySubmit');
    btn.disabled = true;
    btn.textContent = 'Проверка...';
    clearNotification('verificationNotification');

    try {
      const res = await api.verifyEmail({ email: registeredEmail, code: code });
      const token = (res.data && res.data.token) || res.token || res.access_token;
      if (token) {
        localStorage.setItem('auth_token', token);
      }
      showNotification('verificationNotification', 'success', 'Email подтвержден! Переходим...');
      setTimeout(() => { window.location.href = '/static/dashboard.html'; }, 500);
    } catch (err) {
      verAttempts--;
      document.getElementById('verAttempts').textContent = 'Осталось попыток: ' + verAttempts;
      if (verAttempts <= 0) {
        showNotification('verificationNotification', 'error', 'Исчерпаны попытки. Запросите новый код.');
        document.getElementById('verCode').disabled = true;
        btn.disabled = true;
      } else {
        showNotification('verificationNotification', 'error', 'Неверный код. Осталось попыток: ' + verAttempts);
        btn.disabled = false;
      }
      btn.textContent = 'Подтвердить';
    }
  });

  document.getElementById('resendCode')?.addEventListener('click', async function () {
    this.disabled = true;
    clearNotification('verificationNotification');
    try {
      await api.resendCode({ email: registeredEmail });
      verAttempts = 3;
      document.getElementById('verAttempts').textContent = 'Осталось попыток: 3';
      document.getElementById('verCode').disabled = false;
      document.getElementById('verCode').value = '';
      document.getElementById('verifySubmit').disabled = false;
      startResendTimer();
      showNotification('verificationNotification', 'success', 'Новый код отправлен!');
    } catch (err) {
      showNotification('verificationNotification', 'warning', 'Подождите перед повторной отправкой');
      this.disabled = false;
    }
  });

  // Auto-submit when 6 digits entered
  document.getElementById('verCode')?.addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '');
    if (this.value.length === 6) {
      document.getElementById('verificationForm')?.requestSubmit();
    }
  });

  /* ======================================================================
     HEADER SCROLL EFFECT
     ====================================================================== */
  const header = document.getElementById('header');
  function updateHeader() {
    if (window.scrollY > 20) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  }
  window.addEventListener('scroll', updateHeader, { passive: true });
  updateHeader();

  /* ======================================================================
     MOBILE MENU
     ====================================================================== */
  const mobileMenu = document.getElementById('mobileMenu');

  function openMobileMenu() {
    mobileMenu.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeMobileMenu() {
    mobileMenu.classList.remove('open');
    document.body.style.overflow = '';
  }

  document.getElementById('burgerBtn')?.addEventListener('click', openMobileMenu);
  document.getElementById('mobileMenuClose')?.addEventListener('click', closeMobileMenu);
  mobileMenu?.addEventListener('click', function (e) {
    if (e.target === mobileMenu) closeMobileMenu();
  });
  document.querySelectorAll('.mobile-menu__link').forEach(link => {
    link.addEventListener('click', closeMobileMenu);
  });

  /* ======================================================================
     ACTIVE NAV LINK on Scroll
     ====================================================================== */
  const navLinks = document.querySelectorAll('.header__link');
  const sections = document.querySelectorAll('section[id]');

  function updateActiveNav() {
    const scrollY = window.scrollY + 100;
    sections.forEach(sec => {
      const top = sec.offsetTop;
      const h = sec.offsetHeight;
      const id = sec.getAttribute('id');
      if (scrollY >= top && scrollY < top + h) {
        navLinks.forEach(l => {
          l.classList.remove('active');
          if (l.getAttribute('href') === '#' + id) l.classList.add('active');
        });
      }
    });
  }
  window.addEventListener('scroll', updateActiveNav, { passive: true });

  /* ======================================================================
     SCROLL ANIMATIONS (IntersectionObserver)
     ====================================================================== */
  const animElements = document.querySelectorAll('.section-animate');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

    animElements.forEach(function (el) { observer.observe(el); });
  } else {
    animElements.forEach(function (el) { el.classList.add('visible'); });
  }

  /* ======================================================================
     COUNTER ANIMATION
     ====================================================================== */
  const counters = document.querySelectorAll('.counter');
  if ('IntersectionObserver' in window) {
    const counterObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          const el = entry.target;
          const target = parseInt(el.dataset.target, 10);
          animateCounter(el, 0, target, 1500);
          counterObs.unobserve(el);
        }
      });
    }, { threshold: 0.5 });

    counters.forEach(function (c) { counterObs.observe(c); });
  }

  function animateCounter(el, start, end, duration) {
    const startTime = performance.now();
    function step(now) {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      el.textContent = Math.floor(start + (end - start) * eased);
      if (progress < 1) requestAnimationFrame(step);
      else el.textContent = end;
    }
    requestAnimationFrame(step);
  }

  /* ======================================================================
     FAQ ACCORDION
     ====================================================================== */
  document.querySelectorAll('.faq-item__question').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const item = this.closest('.faq-item');
      const isOpen = item.classList.contains('active');
      // Close all
      document.querySelectorAll('.faq-item.active').forEach(function (i) {
        i.classList.remove('active');
        i.querySelector('.faq-item__question').setAttribute('aria-expanded', 'false');
      });
      if (!isOpen) {
        item.classList.add('active');
        this.setAttribute('aria-expanded', 'true');
      }
    });
  });

  /* ======================================================================
     BACK TO TOP
     ====================================================================== */
  const backBtn = document.getElementById('backToTop');
  function updateBackToTop() {
    if (window.scrollY > 600) {
      backBtn.classList.add('visible');
    } else {
      backBtn.classList.remove('visible');
    }
  }
  window.addEventListener('scroll', updateBackToTop, { passive: true });
  backBtn?.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ======================================================================
     SMOOTH SCROLL for anchor links
     ====================================================================== */
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      const href = this.getAttribute('href');
      if (href === '#') return;
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

})();
