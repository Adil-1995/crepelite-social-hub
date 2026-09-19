import { onScopeDispose, ref, shallowRef, watch, type Ref, type WatchSource } from 'vue';
import {
  doc,
  getDocs,
  limit,
  onSnapshot,
  query,
  startAfter,
  type DocumentData,
  type DocumentSnapshot,
  type Query,
  type QueryConstraint,
} from 'firebase/firestore';
import { db } from '@/app/firebase';

export type WithId<T> = T & { id: string };

/** Realtime query bound to reactive inputs. Returns [] while the factory returns null. */
export function useLiveQuery<T>(factory: () => Query<DocumentData> | null, deps: WatchSource[] = []) {
  const items = shallowRef<WithId<T>[]>([]);
  const loading = ref(true);
  const error = ref<Error | null>(null);
  let unsub: (() => void) | null = null;

  const start = () => {
    unsub?.();
    unsub = null;
    const q = factory();
    if (!q) {
      items.value = [];
      loading.value = false;
      return;
    }
    loading.value = true;
    unsub = onSnapshot(
      q,
      (snap) => {
        items.value = snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
        loading.value = false;
        error.value = null;
      },
      (e) => {
        error.value = e;
        loading.value = false;
      },
    );
  };
  watch(deps, start, { immediate: true });
  onScopeDispose(() => unsub?.());
  return { items, loading, error, refresh: start };
}

export function useLiveDoc<T>(pathFactory: () => string | null, deps: WatchSource[] = []) {
  const data = shallowRef<WithId<T> | null>(null);
  const loading = ref(true);
  const exists = ref(false);
  const error = ref<Error | null>(null);
  let unsub: (() => void) | null = null;
  const start = () => {
    unsub?.();
    const p = pathFactory();
    if (!p) {
      data.value = null;
      loading.value = false;
      return;
    }
    loading.value = true;
    unsub = onSnapshot(
      doc(db, p),
      (s) => {
        exists.value = s.exists();
        data.value = s.exists() ? ({ id: s.id, ...(s.data() as T) } as WithId<T>) : null;
        loading.value = false;
      },
      (e) => {
        error.value = e;
        loading.value = false;
      },
    );
  };
  watch(deps, start, { immediate: true });
  onScopeDispose(() => unsub?.());
  return { data, loading, exists, error };
}

/**
 * Cursor pagination (never offsets): pages are fetched with startAfter(lastDoc).
 */
export function usePagedQuery<T>(baseFactory: () => { base: Query<DocumentData>; constraints: QueryConstraint[] } | null, pageSize = 20, deps: WatchSource[] = []) {
  const items: Ref<WithId<T>[]> = shallowRef([]);
  const loading = ref(false);
  const done = ref(false);
  const error = ref<Error | null>(null);
  let cursor: DocumentSnapshot | null = null;
  let generation = 0;

  async function loadMore() {
    const spec = baseFactory();
    if (!spec || loading.value || done.value) return;
    loading.value = true;
    const gen = generation;
    try {
      const constraints = [...spec.constraints, ...(cursor ? [startAfter(cursor)] : []), limit(pageSize)];
      const snap = await getDocs(query(spec.base, ...constraints));
      if (gen !== generation) return;
      items.value = [...items.value, ...snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) }))];
      cursor = snap.docs[snap.docs.length - 1] ?? cursor;
      if (snap.size < pageSize) done.value = true;
      error.value = null;
    } catch (e) {
      error.value = e as Error;
    } finally {
      if (gen === generation) loading.value = false;
    }
  }

  function reset() {
    generation++;
    items.value = [];
    cursor = null;
    done.value = false;
    loading.value = false;
    void loadMore();
  }

  watch(deps, reset, { immediate: true });
  return { items, loading, done, error, loadMore, reset };
}
