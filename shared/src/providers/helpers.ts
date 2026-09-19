import type { MasterContent, VariantContent } from '../domain/types';
import { composeCaption } from './validation';

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export function defaultFromMaster(master: MasterContent): VariantContent {
  return {
    text: master.text,
    title: master.title,
    description: master.description,
    hashtags: [...master.hashtags],
    link: master.link,
  };
}

export function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const trimmed = line.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Title-centric networks (Pinterest, YouTube): derive title/description from master text when absent. */
export function titledFromMaster(master: MasterContent, titleMax: number, appendHashtagsToDescription: boolean): VariantContent {
  return {
    text: master.text,
    title: master.title.trim() || firstLine(master.text, titleMax),
    description: master.description.trim() || composeCaption(master.text, master.hashtags, appendHashtagsToDescription),
    hashtags: [...master.hashtags],
    link: master.link,
  };
}
