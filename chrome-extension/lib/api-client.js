// API client that uses session cookies for authentication
import { getApiBaseUrl, CONFIG } from './config.js';

class ApiClient {
  async _getBaseUrl() {
    // Always resolve fresh — env can change via popup without extension reload
    return getApiBaseUrl();
  }

  // Call this when environment changes to ensure cookie lookup uses correct domain
  clearCache() {
    // No-op now since we always resolve fresh, but kept for API compatibility
  }

  async _request(method, path, body = null) {
    const baseUrl = await this._getBaseUrl();
    const url = `${baseUrl}${path}`;

    const options = {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'NovumAI-Extension',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`API ${method} ${path} failed: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  async get(path) {
    return this._request('GET', path);
  }

  async post(path, body) {
    return this._request('POST', path, body);
  }

  async put(path, body) {
    return this._request('PUT', path, body);
  }

  // Auth
  async getMe() {
    return this.get(CONFIG.ME_ENDPOINT);
  }

  async getCompany() {
    return this.get(CONFIG.COMPANY_ENDPOINT);
  }

  // AssemblyAI token
  async getAssemblyAIToken() {
    return this.post(CONFIG.ASSEMBLYAI_TOKEN_ENDPOINT, {});
  }

  // Calls
  async createCall(data) {
    return this.post(CONFIG.CALLS_ENDPOINT, data);
  }

  async endCall(callConnectionId, data) {
    const path = CONFIG.CALLS_END_ENDPOINT.replace('{callConnectionId}', callConnectionId);
    return this.post(path, data);
  }

  // Leads
  // General search: partial match across phone, name, email, company (min 2 chars)
  async searchLeads(query) {
    const path = `${CONFIG.LEADS_SEARCH_ENDPOINT}?search=${encodeURIComponent(query)}&limit=5`;
    return this.get(path);
  }

  // Exact E.164 phone lookup (requires full +15551234567 format)
  async lookupLeadByPhone(phoneNumber) {
    const path = CONFIG.LEADS_PHONE_LOOKUP_ENDPOINT.replace('{phoneNumber}', encodeURIComponent(phoneNumber));
    return this.get(path);
  }

  async createLead(data) {
    return this.post(CONFIG.LEADS_CREATE_ENDPOINT, data);
  }

  // Session cookie check
  async getSessionCookie() {
    try {
      const cookie = await chrome.cookies.get({
        url: await this._getBaseUrl(),
        name: CONFIG.SESSION_COOKIE_NAME,
      });
      return cookie?.value || null;
    } catch (e) {
      console.warn('[NovumAI] Could not read session cookie:', e);
      return null;
    }
  }

  async isAuthenticated() {
    const cookie = await this.getSessionCookie();
    if (!cookie) return false;

    try {
      const me = await this.getMe();
      // /api/users/me returns user object directly with user_id field
      return !!me?.user_id;
    } catch {
      return false;
    }
  }
}

export const apiClient = new ApiClient();
