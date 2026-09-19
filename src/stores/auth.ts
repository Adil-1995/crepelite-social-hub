import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { auth } from '@/app/firebase';
import { api, type Membership } from '@/services/api';

/**
 * Authentication state. Only the Firebase user object is kept — never any
 * social-network token. Nothing here is persisted by Pinia.
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const ready = ref(false);
  const memberships = ref<Membership[]>([]);
  const canCreateWorkspace = ref(false);
  const emailVerified = ref(false);
  const bootstrapError = ref<string | null>(null);
  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((r) => (readyResolve = r));

  async function bootstrap() {
    bootstrapError.value = null;
    try {
      const res = await api.bootstrapUser({});
      memberships.value = res.memberships;
      canCreateWorkspace.value = res.canCreateWorkspace;
      emailVerified.value = res.emailVerified;

      // bootstrapUser refreshes the workspace membership claim that the
      // Storage rules read. Claims only reach the client on a new token, so
      // force one rather than waiting up to an hour for the automatic refresh.
      await auth.currentUser?.getIdToken(true).catch(() => undefined);
    } catch (e) {
      bootstrapError.value = (e as Error).message;
    }
  }

  onAuthStateChanged(auth, async (u) => {
    user.value = u;
    if (u) await bootstrap();
    else memberships.value = [];
    ready.value = true;
    readyResolve?.();
  });

  const isSignedIn = computed(() => !!user.value);

  async function signInEmail(email: string, password: string) {
    await signInWithEmailAndPassword(auth, email, password);
  }

  async function signUpEmail(name: string, email: string, password: string) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (name) await updateProfile(cred.user, { displayName: name });
    await sendEmailVerification(cred.user).catch(() => undefined);
  }

  async function signInGoogle() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    // Popups are unreliable in installed iOS PWAs; fall back to redirect.
    const standalone = window.matchMedia('(display-mode: standalone)').matches;
    if (standalone) await signInWithRedirect(auth, provider);
    else await signInWithPopup(auth, provider);
  }

  async function resetPassword(email: string) {
    await sendPasswordResetEmail(auth, email);
  }

  async function resendVerification() {
    if (user.value) await sendEmailVerification(user.value);
  }

  async function signOut() {
    await fbSignOut(auth);
  }

  return {
    user,
    ready,
    readyPromise,
    memberships,
    canCreateWorkspace,
    emailVerified,
    bootstrapError,
    isSignedIn,
    bootstrap,
    signInEmail,
    signUpEmail,
    signInGoogle,
    resetPassword,
    resendVerification,
    signOut,
  };
});
