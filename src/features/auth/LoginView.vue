<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Message from 'primevue/message';
import Divider from 'primevue/divider';
import { useAuthStore } from '@/stores/auth';
import { useFeedback } from '@/composables/useFeedback';

/**
 * Sign in / sign up / password reset in one form. Firebase is the only identity
 * source; no credential is ever stored by the app.
 */
type Mode = 'signin' | 'signup' | 'reset';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const { success } = useFeedback();

const mode = ref<Mode>('signin');
const name = ref('');
const email = ref('');
const password = ref('');
const busy = ref(false);
const errorMessage = ref<string | null>(null);

const heading = computed(
  () => ({ signin: 'Sign in', signup: 'Create your account', reset: 'Reset your password' })[mode.value],
);
const submitLabel = computed(
  () => ({ signin: 'Sign in', signup: 'Create account', reset: 'Send reset link' })[mode.value],
);

const emailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()));
const passwordValid = computed(() => password.value.length >= 8);
const canSubmit = computed(() => {
  if (!emailValid.value) return false;
  if (mode.value === 'reset') return true;
  if (!passwordValid.value) return false;
  return mode.value === 'signin' || name.value.trim().length > 0;
});

/** Firebase auth codes → messages a person can act on. */
function friendlyError(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  const map: Record<string, string> = {
    'auth/invalid-credential': 'That email and password do not match an account.',
    'auth/invalid-email': 'That email address is not valid.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/user-not-found': 'No account exists for that email.',
    'auth/wrong-password': 'That email and password do not match an account.',
    'auth/email-already-in-use': 'An account already exists for that email. Try signing in.',
    'auth/weak-password': 'Choose a password of at least 8 characters.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
    'auth/popup-closed-by-user': 'The Google sign-in window was closed.',
    'auth/network-request-failed': 'Network problem — check your connection and try again.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled for this project.',
  };
  return map[code] ?? (e as Error)?.message ?? 'Could not sign you in.';
}

function goAfterAuth() {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
  return router.replace(redirect);
}

async function submit() {
  if (!canSubmit.value || busy.value) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    if (mode.value === 'signin') {
      await auth.signInEmail(email.value.trim(), password.value);
      await goAfterAuth();
    } else if (mode.value === 'signup') {
      await auth.signUpEmail(name.value.trim(), email.value.trim(), password.value);
      await goAfterAuth();
    } else {
      await auth.resetPassword(email.value.trim());
      success('Check your inbox', 'We sent you a link to reset your password.');
      mode.value = 'signin';
    }
  } catch (e) {
    errorMessage.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}

async function google() {
  busy.value = true;
  errorMessage.value = null;
  try {
    await auth.signInGoogle();
    await goAfterAuth();
  } catch (e) {
    errorMessage.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}

function switchTo(m: Mode) {
  mode.value = m;
  errorMessage.value = null;
}
</script>

<template>
  <div class="safe-top safe-bottom flex min-h-dvh items-center justify-center bg-app px-4 py-8">
    <div class="w-full max-w-sm">
      <div class="mb-6 flex flex-col items-center gap-2 text-center">
        <img src="/favicon.svg" alt="" class="h-12 w-12" aria-hidden="true" />
        <h1 class="text-xl font-semibold text-ink">CrepeLite Social Hub</h1>
        <p class="text-sm text-ink-muted">Plan and publish to every network from one place.</p>
      </div>

      <div class="card p-5">
        <h2 class="mb-4 text-lg font-semibold text-ink">{{ heading }}</h2>

        <Message v-if="errorMessage" severity="error" :closable="false" class="mb-4">
          {{ errorMessage }}
        </Message>

        <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
          <div v-if="mode === 'signup'" class="flex flex-col gap-1.5">
            <label for="name" class="text-sm font-medium text-ink">Your name</label>
            <InputText id="name" v-model="name" autocomplete="name" :disabled="busy" fluid />
          </div>

          <div class="flex flex-col gap-1.5">
            <label for="email" class="text-sm font-medium text-ink">Email</label>
            <InputText
              id="email"
              v-model="email"
              type="email"
              autocomplete="email"
              inputmode="email"
              :invalid="email.length > 0 && !emailValid"
              :disabled="busy"
              fluid
            />
          </div>

          <div v-if="mode !== 'reset'" class="flex flex-col gap-1.5">
            <label for="password" class="text-sm font-medium text-ink">Password</label>
            <Password
              id="password"
              v-model="password"
              :feedback="mode === 'signup'"
              toggle-mask
              :autocomplete="mode === 'signup' ? 'new-password' : 'current-password'"
              :invalid="password.length > 0 && !passwordValid"
              :disabled="busy"
              fluid
              :input-props="{ 'aria-describedby': 'password-help' }"
            />
            <small v-if="mode === 'signup'" id="password-help" class="text-ink-soft">
              At least 8 characters.
            </small>
          </div>

          <Button type="submit" :label="submitLabel" :loading="busy" :disabled="!canSubmit" fluid />
        </form>

        <template v-if="mode !== 'reset'">
          <Divider align="center"><span class="text-xs text-ink-soft">or</span></Divider>
          <Button
            label="Continue with Google"
            icon="pi pi-google"
            severity="secondary"
            outlined
            fluid
            :disabled="busy"
            @click="google"
          />
        </template>

        <div class="mt-5 flex flex-col items-center gap-2 text-sm">
          <template v-if="mode === 'signin'">
            <Button label="Forgot your password?" text size="small" @click="switchTo('reset')" />
            <p class="text-ink-muted">
              New here?
              <Button label="Create an account" text size="small" @click="switchTo('signup')" />
            </p>
          </template>
          <template v-else>
            <Button label="Back to sign in" text size="small" icon="pi pi-arrow-left" @click="switchTo('signin')" />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
