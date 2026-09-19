import type { AiCaptionRequest, AiContentSettings, AiLanguage, AiTone, ProviderManifest } from '@shared/index';

/**
 * Prompt construction.
 *
 * Kept apart from any vendor SDK so the wording is reviewable on its own and
 * survives a change of model provider — it is the part that decides whether
 * the output sounds like a Casablanca dessert shop or like a press release.
 */

/**
 * Darija needs more than "write in Arabic".
 *
 * Asking a model for Arabic reliably produces Modern Standard Arabic, which in
 * a social caption reads like a government notice. These instructions name the
 * register, ban the giveaway MSA constructions, and give worked examples of
 * both the target voice and the failure mode.
 */
const DARIJA_GUIDE = `
You are writing Moroccan Darija (الدارجة المغربية) in ARABIC SCRIPT.

This is a spoken dialect written down, not Modern Standard Arabic. Get this
wrong and the text reads like a formal announcement instead of a local
business talking to its neighbours.

Rules:
- Write in the Arabic alphabet. Never transliterate into Latin letters.
- Use everyday Moroccan words: بزاف, دابا, واش, هاد, شنو, كتفضل, غادي, ديال, مزيان.
- Keep sentences short. Two or three lines is a caption; a paragraph is not.
- Write the way people post, not the way brochures are written.
- Avoid MSA constructions and vocabulary unless a word has no Darija
  equivalent: no يسرنا, no نقدم لكم, no ذات مذاق رائع, no إننا, no لدينا الشرف.
- Never translate word for word from French or Spanish. Write it as a Moroccan
  would say it from scratch.
- Keep brand and product names as they are written.

Good — this is the target:
"واش نتا من عشاق الشوكولا؟ 😍🍫
هاد الكريب غادي يعجبك بزاف!"

"هاد الكريب واجد باش يرضي عشاق الشوكولا 😍🍫
شنو كتفضلو أكثر: الشوكولا ولا الفواكه؟"

Bad — too formal, this is MSA and must be avoided:
"يسرنا أن نقدم لكم فطيرة لذيذة ذات مذاق رائع"
"نتشرف بتقديم أشهى الحلويات لزبنائنا الكرام"
`.trim();

const LANGUAGE_GUIDE: Record<AiLanguage, string> = {
  ary: DARIJA_GUIDE,
  ar: 'Write in Modern Standard Arabic (العربية الفصحى), in Arabic script. Keep it warm and readable rather than formal or bureaucratic.',
  fr: 'Write in French, in the register a young French-speaking Moroccan brand would use on social media. Natural, not stiff.',
  en: 'Write in English, in the register a young brand would use on social media. Natural, not corporate.',
};

const TONE_GUIDE: Record<AiTone, string> = {
  natural: 'Conversational and warm, like recommending the place to a friend.',
  promotional: 'Persuasive and appetising, but still human. No hard-sell clichés.',
  reel: 'Very short. A hook in the first line. Built for Reels and TikTok, where the first few words decide whether anyone reads on.',
  elegant: 'Refined and understated. Fewer words, chosen carefully.',
  brand: "The brand's own voice as described in the brand context below.",
};

/** Rules that hold whatever the language, tone or network. */
const GROUNDING_RULES = `
Hard rules — breaking any of these makes the output unusable:
- Describe only what is actually in the media. Do not invent ingredients,
  toppings, flavours, people or surroundings that are not visible.
- Never invent a promotion, a discount, a price, an opening time or an award.
- Never invent a location. Mention a place only if you are given one.
- Do not claim anything about health, nutrition or provenance.
- If the media is unclear, write something that stays true to what you can see
  rather than guessing.
`.trim();

export function buildSystemPrompt(settings: AiContentSettings, language: AiLanguage, tone: AiTone): string {
  const parts = [
    'You write social media captions for a small business.',
    '',
    `BUSINESS CONTEXT:\n${settings.brandContext}`,
    '',
    `LANGUAGE:\n${LANGUAGE_GUIDE[language]}`,
    '',
    `TONE:\n${TONE_GUIDE[tone]}`,
    '',
    GROUNDING_RULES,
  ];

  if (settings.forbiddenClaims.length) {
    parts.push('', `NEVER claim or mention the following:\n- ${settings.forbiddenClaims.join('\n- ')}`);
  }

  return parts.join('\n');
}

export function buildCaptionInstruction(request: AiCaptionRequest, settings: AiContentSettings, hasMedia: boolean): string {
  const wants: string[] = [];
  wants.push(request.useEmojis ? 'Include a few well-placed emojis.' : 'Do not use any emojis.');
  wants.push(
    request.useHashtags
      ? `Return 3-6 relevant hashtags separately in the "hashtags" field, without the # sign.${
          settings.defaultHashtags.length ? ` Always include: ${settings.defaultHashtags.join(', ')}.` : ''
        }`
      : 'Return an empty hashtags array.',
  );
  wants.push(
    request.useCta
      ? 'End with a light call to action — a question or an invitation, not a command.'
      : 'Do not add a call to action.',
  );

  if (request.mentionLocation && settings.defaultLocation) {
    wants.push(`You may mention the location: ${settings.defaultLocation}.`);
  } else {
    wants.push('Do not mention any location.');
  }

  wants.push(
    hasMedia
      ? 'Base the caption on what you can see in the attached media. Say what is actually there.'
      : 'There is no media. Write from the business context alone and stay general rather than inventing specifics.',
  );

  if (request.seedText?.trim()) {
    wants.push(`The user has already written this; keep its intent:\n"""${request.seedText.trim()}"""`);
  }

  return wants.join('\n');
}

/** Asks the model to describe the media before writing, so the text is grounded. */
export const UNDERSTANDING_INSTRUCTION = `
First look at the media and record what you actually see in the "understanding"
field: a one-sentence summary, and a list of concrete subjects (the product,
visible toppings, the setting). Then write the captions from that.
`.trim();

export function buildRewriteInstruction(instruction: string): string {
  const map: Record<string, string> = {
    shorter: 'Make it noticeably shorter while keeping the point.',
    longer: 'Expand it a little with relevant detail. Do not invent facts.',
    more_promotional: 'Make it more persuasive and appetising, still human.',
    more_natural: 'Make it more conversational and less salesy.',
    add_emojis: 'Add a few well-placed emojis.',
    remove_emojis: 'Remove every emoji.',
    add_cta: 'Add a light call to action at the end.',
  };
  return map[instruction] ?? 'Improve it.';
}

/**
 * Describes one destination to the model from its manifest, so the variant
 * respects the fields and limits that network actually has.
 */
export function describePlatform(manifest: ProviderManifest, channelName: string): string {
  const f = manifest.capabilities.fields;
  const lines = [`${manifest.displayName} (account "${channelName}")`];

  if (f.text.supported) {
    lines.push(`- caption: ${f.text.maxLength ? `max ${f.text.maxLength} characters` : 'no hard limit'}`);
  } else {
    lines.push('- caption: not supported, leave empty');
  }
  if (f.title.supported) {
    lines.push(`- title: ${f.title.required ? 'REQUIRED, ' : ''}${f.title.maxLength ? `max ${f.title.maxLength}` : 'no hard limit'}`);
  } else {
    lines.push('- title: not supported, leave empty');
  }
  if (f.description.supported) {
    lines.push(`- description: ${f.description.maxLength ? `max ${f.description.maxLength}` : 'no hard limit'}`);
  } else {
    lines.push('- description: not supported, leave empty');
  }
  lines.push(`- hashtags: ${f.hashtags.supported ? `up to ${f.hashtags.max ?? 10}` : 'not supported, return an empty array'}`);

  return lines.join('\n');
}

export const PLATFORM_STYLE_GUIDE = `
Shape each variant for where it is going:
- Instagram: visual and warm, emojis, hashtags carry reach.
- Facebook: slightly longer and more descriptive, fewer hashtags.
- TikTok: very short, a hook in the first words.
- Pinterest: a searchable title plus a descriptive line; think of someone
  looking for an idea rather than following a brand.
- YouTube: a clear title and a fuller description.

Keep the same message and facts across all of them. Only the shape changes.
`.trim();
