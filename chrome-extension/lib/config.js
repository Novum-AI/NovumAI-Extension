// NovumAI Extension Configuration
// All backend URLs and constants

export const CONFIG = {
  // Webapp URLs (for post-call analytics redirect)
  WEBAPP_URL_DEV: 'https://dev.novumai.co',
  WEBAPP_URL_PROD: 'https://www.novumai.co',

  // API endpoints
  API_BASE_URL_DEV: 'https://dev-api.novumai.co',
  API_BASE_URL_PROD: 'https://api.novumai.co',

  // WebSocket endpoints
  WS_URL_DEV: 'wss://dev-ws.novumai.co',
  WS_URL_PROD: 'wss://ws.novumai.co',

  // AssemblyAI
  ASSEMBLYAI_WS_URL: 'wss://streaming.assemblyai.com/v3/ws',
  ASSEMBLYAI_TOKEN_ENDPOINT: '/api/assemblyai/realtime-token',

  // Auth
  SESSION_COOKIE_NAME: 'session_id',
  COOKIE_DOMAIN: '.novumai.co',
  ME_ENDPOINT: '/api/users/me',
  COMPANY_ENDPOINT: '/api/companies/me',

  // Calls
  CALLS_ENDPOINT: '/api/calls/',
  CALLS_END_ENDPOINT: '/api/calls/{callConnectionId}/end',

  // WebSocket token
  WEBSOCKET_TOKEN_ENDPOINT: '/api/users/websocket-token',

  // CRM entity resolution (unified SF + local leads)
  CRM_ENTITY_PHONE_ENDPOINT: '/api/crm/entities/phone/{phoneNumber}',

  // Leads
  LEADS_SEARCH_ENDPOINT: '/api/leads/',           // GET ?search=term (partial match across phone/name/email/company)
  LEADS_PHONE_LOOKUP_ENDPOINT: '/api/leads/phone/{phoneNumber}',  // GET exact E.164 phone lookup (local only)
  LEADS_CREATE_ENDPOINT: '/api/leads/',

  // Audio
  SAMPLE_RATE: 16000,
  ENCODING: 'pcm_s16le',
  BUFFER_TARGET_SAMPLES: 1600, // 100ms at 16kHz
  MIN_END_OF_TURN_SILENCE_CUSTOMER: 750,
  MIN_END_OF_TURN_SILENCE_AGENT: 700,
  MAX_TURN_SILENCE: 2400,

  // Retry
  MAX_RETRIES: 5,
  RETRY_DELAY_MS: 1000,
  RETRY_POLL_INTERVAL_MS: 2000,

  // Call stages (NEPQ/Sales)
  CALL_STAGES: [
    'CALL_OPENING',
    'BUILD_RAPPORT',
    'PERMISSION_TO_QUESTION',
    'PROBLEM_AWARENESS',
    'SOLUTION_AWARENESS',
    'CONSEQUENCE',
    'PRESENTATION',
    'OBJECTION_HANDLING',
    'COMMITMENT',
    'CALL_TERMINATION'
  ],

  // Supported pages
  SUPPORTED_URLS: [
    'https://meet.google.com/'
  ]
};

// Determine environment from stored setting or default to dev
export async function getEnvironment() {
  const result = await chrome.storage.local.get('environment');
  return result.environment || 'development';
}

export async function getApiBaseUrl() {
  const env = await getEnvironment();
  if (env === 'production') return CONFIG.API_BASE_URL_PROD;
  return CONFIG.API_BASE_URL_DEV;
}

export async function getWsUrl() {
  const env = await getEnvironment();
  if (env === 'production') return CONFIG.WS_URL_PROD;
  return CONFIG.WS_URL_DEV;
}

export async function getWebappUrl() {
  const env = await getEnvironment();
  if (env === 'production') return CONFIG.WEBAPP_URL_PROD;
  return CONFIG.WEBAPP_URL_DEV;
}
