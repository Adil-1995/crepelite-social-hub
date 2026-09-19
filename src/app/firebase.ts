import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

/**
 * Firebase Web SDK bootstrap. Only public configuration lives here (VITE_*).
 * No token, secret or provider credential ever reaches the client.
 */
const env = import.meta.env;
export const useEmulators = env.VITE_USE_EMULATORS === 'true';
export const appEnv = env.VITE_APP_ENV ?? (useEmulators ? 'development' : 'production');

export const firebaseApp = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-api-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'demo-crepelite.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'demo-crepelite',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'demo-crepelite.appspot.com',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '0',
  appId: env.VITE_FIREBASE_APP_ID || '1:0:web:0',
});

export const auth = getAuth(firebaseApp);

function makeCache() {
  try {
    // Offline persistence: the app shell + recently viewed data work offline.
    return persistentLocalCache({ tabManager: persistentMultipleTabManager() });
  } catch {
    return memoryLocalCache();
  }
}
export const db = initializeFirestore(firebaseApp, { localCache: makeCache(), ignoreUndefinedProperties: true });
export const storage = getStorage(firebaseApp);
export const functions = getFunctions(firebaseApp, env.VITE_FUNCTIONS_REGION || 'europe-west1');

if (useEmulators) {
  const host = window.location.hostname;
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectFunctionsEmulator(functions, host, 5001);
  connectStorageEmulator(storage, host, 9199);
}
