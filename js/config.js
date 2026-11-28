// Конфигурация приложения, Firebase, PWA-иконок и ключей локального хранилища

export const firebaseConfig = {
  apiKey: "AIzaSyDZbqWMzauTBLFxlTFaeQYSiz0sSyWG7DA",
  authDomain: "children-b0573.firebaseapp.com",
  projectId: "children-b0573",
  storageBucket: "children-b0573.firebasestorage.app",
  messagingSenderId: "862463032073",
  appId: "1:862463032073:web:4d2fdf0e1f573fac4e31d8"
};

export const appId = firebaseConfig.projectId;
export const FIREBASE_COLLECTION_PATH = ['artifacts', appId, 'public', 'data', 'malysh_accounts'];
export const LEGACY_FIREBASE_COLLECTION_PATH = ['artifacts', appId, 'public', 'data', 'accounts'];
export const FIREBASE_INVITES_COLLECTION_PATH = ['artifacts', appId, 'public', 'data', 'malysh_invites'];
export const FIREBASE_ADMIN_CONFIG_PATH = ['artifacts', appId, 'public', 'data', 'malysh_admin_config'];

export const APP_ICON_URL = 'https://kowkin-kot.github.io/children/app_icon.svg';
export const APP_ICON_PNG_URL = 'https://kowkin-kot.github.io/children/app_icon.png';

export const LOCAL_ACCOUNTS_KEY = 'malysh_plus_accounts_v1';
export const LOCAL_SESSION_KEY = 'malysh_plus_session_v1';
export const LOCAL_CAREGIVER_KEY = 'malysh_plus_caregiver_v1';
