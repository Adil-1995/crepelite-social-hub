import { computed, reactive, ref, watch } from 'vue';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import {
  EMPTY_MASTER_CONTENT,
  contentFromMaster,
  defaultSettings,
  hasBlockingIssues,
  resolveVariantContent,
  suggestFormat,
  validateVariant,
  type MasterContent,
  type MediaAsset,
  type MediaInfo,
  type Post,
  type PostVariant,
  type ProviderManifest,
  type SyncMode,
  type ValidationIssue,
  type VariantContent,
} from '@shared/index';
import { db } from '@/app/firebase';
import { api } from '@/services/api';
import { useWorkspaceStore } from '@/stores/workspace';
import { useProvidersStore } from '@/stores/providers';
import { toMillis } from '@/lib/format';

/**
 * Composer state.
 *
 * One master content plus one variant per selected channel. Linked variants
 * always re-derive from the master; customised ones keep their own copy until
 * the user resets them. Validation is the same shared code the backend runs, so
 * the review step cannot disagree with the server.
 *
 * Work in progress is mirrored to IndexedDB so a draft survives going offline
 * or closing the tab before it is saved.
 */

export interface DraftVariant {
  channelId: string;
  provider: string;
  syncMode: SyncMode;
  format: string;
  content: VariantContent;
  mediaIds: string[] | null;
  providerSettings: Record<string, unknown>;
  offsetMinutes: number;
}

export interface ComposerDraft {
  postId: string | null;
  titleInternal: string;
  masterContent: MasterContent;
  mediaIds: string[];
  internalNotes: string;
  variants: DraftVariant[];
  scheduledAtMs: number | null;
  expectedRevision: number | null;
  savedAt: number;
}

const LOCAL_KEY = (workspaceId: string, postId: string | null) => `crepelite:draft:${workspaceId}:${postId ?? 'new'}`;

function emptyDraft(): ComposerDraft {
  return {
    postId: null,
    titleInternal: '',
    masterContent: { ...EMPTY_MASTER_CONTENT, hashtags: [] },
    mediaIds: [],
    internalNotes: '',
    variants: [],
    scheduledAtMs: null,
    expectedRevision: null,
    savedAt: Date.now(),
  };
}

export function useComposer(postIdRef: () => string | undefined) {
  const ws = useWorkspaceStore();
  const providers = useProvidersStore();

  const draft = reactive<ComposerDraft>(emptyDraft());
  const mediaById = reactive(new Map<string, MediaAsset>());
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const saving = ref(false);
  const restoredFromLocal = ref(false);
  const dirty = ref(false);

  // ── media ────────────────────────────────────────────────────────────────

  async function fetchMedia(ids: string[]): Promise<void> {
    const missing = ids.filter((id) => !mediaById.has(id));
    if (!ws.workspaceId || !missing.length) return;
    const snaps = await Promise.all(
      missing.map((id) => getDoc(doc(db, `workspaces/${ws.workspaceId}/mediaAssets/${id}`)).catch(() => null)),
    );
    for (const snap of snaps) {
      if (snap?.exists()) mediaById.set(snap.id, { ...(snap.data() as MediaAsset), id: snap.id });
    }
  }

  /** MediaInfo for validation, in the order the user arranged them. */
  function mediaInfo(ids: string[]): MediaInfo[] {
    return ids
      .map((id) => mediaById.get(id))
      .filter((a): a is MediaAsset => !!a)
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        mimeType: a.mimeType,
        size: a.size,
        width: a.width,
        height: a.height,
        durationSec: a.durationSec,
        fileName: a.fileName,
      }));
  }

  const selectedMedia = computed(() => mediaInfo(draft.mediaIds));

  // ── variants ─────────────────────────────────────────────────────────────

  const selectedChannelIds = computed<string[]>({
    get: () => draft.variants.map((v) => v.channelId),
    set: (ids) => syncVariants(ids),
  });

  function manifestFor(provider: string): ProviderManifest | undefined {
    return providers.manifest(provider);
  }

  /** Adds variants for newly selected channels and drops deselected ones. */
  function syncVariants(channelIds: string[]) {
    const existing = new Map(draft.variants.map((v) => [v.channelId, v]));
    const next: DraftVariant[] = [];

    for (const channelId of channelIds) {
      const kept = existing.get(channelId);
      if (kept) {
        next.push(kept);
        continue;
      }
      const channel = ws.channels.find((c) => c.id === channelId);
      if (!channel) continue;
      const manifest = manifestFor(channel.provider);
      if (!manifest) continue;

      const format = suggestFormat(manifest, selectedMedia.value)?.id ?? manifest.capabilities.formats[0]?.id ?? '';
      next.push({
        channelId,
        provider: channel.provider,
        syncMode: 'master',
        format,
        content: contentFromMaster(manifest, draft.masterContent),
        mediaIds: null,
        providerSettings: defaultSettings(manifest),
        offsetMinutes: 0,
      });
    }

    draft.variants = next;
    dirty.value = true;
  }

  /** Effective content for a variant: linked follows the master, custom does not. */
  function effectiveContent(variant: DraftVariant): VariantContent {
    const manifest = manifestFor(variant.provider);
    if (!manifest) return variant.content;
    return resolveVariantContent(manifest, draft.masterContent, variant);
  }

  function effectiveMediaIds(variant: DraftVariant): string[] {
    return variant.mediaIds ?? draft.mediaIds;
  }

  function customise(channelId: string) {
    const v = draft.variants.find((x) => x.channelId === channelId);
    if (!v) return;
    v.content = { ...effectiveContent(v) };
    v.syncMode = 'custom';
    dirty.value = true;
  }

  function resetToMaster(channelId: string) {
    const v = draft.variants.find((x) => x.channelId === channelId);
    if (!v) return;
    const manifest = manifestFor(v.provider);
    v.content = manifest ? contentFromMaster(manifest, draft.masterContent) : { ...draft.masterContent };
    v.mediaIds = null;
    v.syncMode = 'master';
    dirty.value = true;
  }

  function applyMasterTo(channelIds: string[]) {
    for (const id of channelIds) resetToMaster(id);
  }

  // ── validation ───────────────────────────────────────────────────────────

  const issuesByChannel = computed<Record<string, ValidationIssue[]>>(() => {
    const out: Record<string, ValidationIssue[]> = {};
    for (const v of draft.variants) {
      const manifest = manifestFor(v.provider);
      if (!manifest) {
        out[v.channelId] = [
          { field: 'provider', code: 'unknown_provider', message: 'This network is no longer available.', severity: 'error' },
        ];
        continue;
      }
      const channel = ws.channels.find((c) => c.id === v.channelId);
      out[v.channelId] = validateVariant(manifest, {
        format: v.format,
        content: effectiveContent(v),
        media: mediaInfo(effectiveMediaIds(v)),
        settings: v.providerSettings,
        ...(channel?.metadata ? { channelMetadata: channel.metadata } : {}),
      });
    }
    return out;
  });

  const blockingChannels = computed(() =>
    draft.variants.filter((v) => hasBlockingIssues(issuesByChannel.value[v.channelId] ?? [])).map((v) => v.channelId),
  );

  const canSchedule = computed(
    () => draft.variants.length > 0 && blockingChannels.value.length === 0 && draft.scheduledAtMs != null,
  );
  const canPublishNow = computed(() => draft.variants.length > 0 && blockingChannels.value.length === 0);

  // ── local (offline) draft ────────────────────────────────────────────────

  function localKey(): string | null {
    return ws.workspaceId ? LOCAL_KEY(ws.workspaceId, postIdRef() ?? null) : null;
  }

  async function saveLocal() {
    const key = localKey();
    if (!key) return;
    draft.savedAt = Date.now();
    await idbSet(key, JSON.parse(JSON.stringify(draft)) as ComposerDraft).catch(() => undefined);
  }

  async function clearLocal() {
    const key = localKey();
    if (key) await idbDel(key).catch(() => undefined);
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  watch(
    () => JSON.stringify(draft),
    () => {
      dirty.value = true;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void saveLocal(), 800);
    },
  );

  // ── load ─────────────────────────────────────────────────────────────────

  async function load() {
    const postId = postIdRef();
    loading.value = true;
    loadError.value = null;
    try {
      if (postId && ws.workspaceId) {
        const snap = await getDoc(doc(db, `workspaces/${ws.workspaceId}/posts/${postId}`));
        if (!snap.exists()) {
          loadError.value = 'This post no longer exists.';
          return;
        }
        const post = { ...(snap.data() as Post), id: snap.id };
        const variantSnap = await getDocs(
          query(collection(db, `workspaces/${ws.workspaceId}/postVariants`), where('postId', '==', postId)),
        );
        const variants = variantSnap.docs.map((d) => ({ ...(d.data() as PostVariant), id: d.id }));

        draft.postId = post.id;
        draft.titleInternal = post.titleInternal ?? '';
        draft.masterContent = { ...EMPTY_MASTER_CONTENT, ...post.masterContent, hashtags: [...(post.masterContent?.hashtags ?? [])] };
        draft.mediaIds = [...(post.mediaIds ?? [])];
        draft.internalNotes = post.internalNotes ?? '';
        draft.expectedRevision = post.revision ?? null;
        draft.scheduledAtMs = toMillis(post.schedule?.scheduledAt ?? post.calendarAt ?? null);
        draft.variants = variants.map((v) => ({
          channelId: v.channelId,
          provider: v.provider,
          syncMode: v.syncMode,
          format: v.format,
          content: { ...v.content },
          mediaIds: v.mediaIds ? [...v.mediaIds] : null,
          providerSettings: { ...(v.providerSettings ?? {}) },
          offsetMinutes: v.offsetMinutes ?? 0,
        }));
      }

      // A newer local copy wins: it is work the server has not seen.
      const key = localKey();
      if (key) {
        const local = await idbGet<ComposerDraft>(key).catch(() => undefined);
        if (local && (!postId || local.savedAt > Date.now() - 7 * 24 * 3600 * 1000)) {
          const serverIsNewer = postId != null && local.expectedRevision != null && draft.expectedRevision != null
            ? local.expectedRevision < draft.expectedRevision
            : false;
          if (!serverIsNewer) {
            Object.assign(draft, local, { postId: draft.postId ?? local.postId });
            restoredFromLocal.value = true;
          }
        }
      }

      await fetchMedia([...draft.mediaIds, ...draft.variants.flatMap((v) => v.mediaIds ?? [])]);
      dirty.value = false;
    } catch (e) {
      loadError.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  // ── save ─────────────────────────────────────────────────────────────────

  function toPayload() {
    return {
      workspaceId: ws.workspaceId!,
      titleInternal: draft.titleInternal.trim(),
      masterContent: draft.masterContent,
      mediaIds: draft.mediaIds,
      internalNotes: draft.internalNotes,
      timezone: ws.timezone,
      scheduledAt: draft.scheduledAtMs ? new Date(draft.scheduledAtMs).toISOString() : null,
      variants: draft.variants.map((v) => ({
        channelId: v.channelId,
        syncMode: v.syncMode,
        format: v.format,
        ...(v.syncMode === 'custom' ? { content: v.content } : {}),
        mediaIds: v.mediaIds,
        providerSettings: v.providerSettings,
        offsetMinutes: v.offsetMinutes,
        scheduledAtOverride: null,
      })),
    };
  }

  /** Creates or updates the post. Returns the post id. */
  async function save(): Promise<string> {
    saving.value = true;
    try {
      const payload = toPayload();
      if (draft.postId) {
        const res = await api.updatePost({
          ...payload,
          postId: draft.postId,
          ...(draft.expectedRevision != null ? { expectedRevision: draft.expectedRevision } : {}),
        });
        draft.expectedRevision = res.revision;
      } else {
        const res = await api.createPost(payload);
        draft.postId = res.postId;
      }
      dirty.value = false;
      await clearLocal();
      return draft.postId!;
    } finally {
      saving.value = false;
    }
  }

  async function saveAndSchedule(): Promise<string> {
    const postId = await save();
    if (draft.scheduledAtMs == null) return postId;
    await api.schedulePost({
      workspaceId: ws.workspaceId!,
      postId,
      scheduledAt: new Date(draft.scheduledAtMs).toISOString(),
      timezone: ws.timezone,
    });
    return postId;
  }

  async function saveAndPublish(): Promise<string> {
    const postId = await save();
    await api.publishNow({ workspaceId: ws.workspaceId!, postId });
    return postId;
  }

  // Keep linked variants in step with the master so previews never lag.
  watch(
    () => JSON.stringify(draft.masterContent),
    () => {
      for (const v of draft.variants) {
        if (v.syncMode !== 'master') continue;
        const manifest = manifestFor(v.provider);
        if (manifest) v.content = contentFromMaster(manifest, draft.masterContent);
      }
    },
  );

  // Re-suggest formats when the media set changes (image → video, etc.).
  watch(
    () => draft.mediaIds.join(','),
    async () => {
      await fetchMedia(draft.mediaIds);
      for (const v of draft.variants) {
        const manifest = manifestFor(v.provider);
        if (!manifest) continue;
        const media = mediaInfo(effectiveMediaIds(v));
        const suggested = suggestFormat(manifest, media);
        const current = manifest.capabilities.formats.find((f) => f.id === v.format);
        const fitsCurrent =
          current && media.length >= current.media.min && media.length <= current.media.max;
        if (suggested && !fitsCurrent) v.format = suggested.id;
      }
    },
  );

  return {
    draft,
    mediaById,
    selectedMedia,
    selectedChannelIds,
    issuesByChannel,
    blockingChannels,
    canSchedule,
    canPublishNow,
    loading,
    loadError,
    saving,
    dirty,
    restoredFromLocal,
    load,
    save,
    saveAndSchedule,
    saveAndPublish,
    clearLocal,
    fetchMedia,
    mediaInfo,
    manifestFor,
    effectiveContent,
    effectiveMediaIds,
    customise,
    resetToMaster,
    applyMasterTo,
  };
}
