const api = {
  baseUrl: '/api',

  async fetch(endpoint, options = {}) {
    const token = localStorage.getItem('auth_token');

    if (token) {
      options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${token}`
      };
    }

    if (options.body && typeof options.body !== 'string') {
      options.headers = {
        ...options.headers,
        'Content-Type': 'application/json'
      };
      options.body = JSON.stringify(options.body);
    }

    try {
      const response = await window.fetch(`${this.baseUrl}${endpoint}`, options);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || data.message || 'API Error');
      }

      return data;
    } catch (error) {
      console.error('API Error:', error);
      throw error;
    }
  },

  register(userData) {
    return this.fetch('/auth/register', {
      method: 'POST',
      body: userData
    });
  },

  login(credentials) {
    return this.fetch('/auth/login', {
      method: 'POST',
      body: credentials
    });
  },

  verifyEmail(data) {
    return this.fetch('/email-verification/verify', {
      method: 'POST',
      body: data
    });
  },

  resendVerificationCode(data) {
    return this.fetch('/email-verification/resend', {
      method: 'POST',
      body: data
    });
  }
};

export default api;
