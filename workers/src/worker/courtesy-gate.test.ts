import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationMessage } from '../core/types.js';
import type { AuxLlmCall } from './aux-llm.js';
import { classifyCourtesySkip, COURTESY_PROMPT, courtesyCandidate, parseCourtesySkip } from './courtesy-gate.js';

const llm: AuxLlmCall = {
  clientId: 'client1', ghlConversationId: 'conv1', provider: 'openai', apiKey: 'k', model: 'gpt-6-luna', keySource: 'platform',
};

let clock = 0;
const msg = (senderType: ConversationMessage['senderType'], content: string): ConversationMessage => ({
  direction: senderType === 'lead' ? 'inbound' : 'outbound',
  senderType,
  content,
  sentAt: new Date(Date.UTC(2026, 9, 13, 21, 0, clock++)).toISOString(),
});

beforeEach(() => {
  clock = 0;
  vi.unstubAllGlobals();
});

describe('courtesyCandidate — the free filter in front of the classifier', () => {
  it('courtesy after a bot message that asked nothing → candidate, from the first courtesy message', () => {
    const tail = [msg('lead', 'Ok lunes 5:45pm'), msg('bot', '¡Con gusto! Te esperamos.'), msg('lead', 'Gracias'), msg('lead', '👍')];
    expect(courtesyCandidate(tail)).toEqual({ since: tail[2]!.sentAt });
  });

  it('a thank-you to a booking confirmation is still a candidate — the classifier decides it gets a reply', () => {
    expect(courtesyCandidate([msg('bot', 'Listo, tu cita quedó el miércoles.'), msg('lead', 'Gracias')])).not.toBeNull();
  });

  it('the bot asked something → the "Ok" may be a yes: not a candidate', () => {
    expect(courtesyCandidate([msg('bot', '¿Te aparto el miércoles a las 3:45?'), msg('lead', 'Ok')])).toBeNull();
  });

  it('the lead asks something, in any message of the burst → not a candidate', () => {
    expect(courtesyCandidate([msg('bot', 'Te esperamos.'), msg('lead', '¿hay estacionamiento?')])).toBeNull();
    expect(courtesyCandidate([msg('bot', 'Te esperamos.'), msg('lead', '¿y estacionamiento?'), msg('lead', 'gracias')])).toBeNull();
    expect(courtesyCandidate([msg('bot', 'Te esperamos.'), msg('lead', '¿Hay estacionamiento')])).toBeNull();
  });

  it('a long message → not a candidate', () => {
    const long = 'Gracias, oye y una pregunta, mi hermana también quiere ir a la consulta el mismo día';
    expect(courtesyCandidate([msg('bot', 'Te esperamos.'), msg('lead', long)])).toBeNull();
  });

  it('media (voice note, photo) → not a candidate', () => {
    expect(courtesyCandidate([msg('bot', 'Te esperamos.'), msg('lead', '[nota de voz]')])).toBeNull();
    expect(courtesyCandidate([msg('bot', 'Te esperamos.'), msg('lead', '[Foto que mandó: una mano]')])).toBeNull();
  });

  it('a human\'s message last (the pause path owns that) or no bot message at all → not a candidate', () => {
    expect(courtesyCandidate([msg('human_agent', 'Con gusto'), msg('lead', 'Gracias')])).toBeNull();
    expect(courtesyCandidate([msg('lead', 'Gracias')])).toBeNull();
    expect(courtesyCandidate([msg('bot', 'Te esperamos.')])).toBeNull();
    expect(courtesyCandidate([])).toBeNull();
  });
});

describe('classifyCourtesySkip', () => {
  const tail = [msg('bot', '¡Con gusto! Te esperamos.'), msg('lead', '👍')];
  const stub = (content: string | null, ok = true) => {
    const f = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content } }] }) });
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('reads the verdict', async () => {
    stub('{"skip":true}');
    expect(await classifyCourtesySkip(tail, llm)).toBe(true);
    stub('{"skip":false}');
    expect(await classifyCourtesySkip(tail, llm)).toBe(false);
  });

  it('a failed or unparseable call replies (false)', async () => {
    stub(null, false);
    expect(await classifyCourtesySkip(tail, llm)).toBe(false);
    stub('no sé');
    expect(await classifyCourtesySkip(tail, llm)).toBe(false);
    stub('{"skip":"yes"}');
    expect(await classifyCourtesySkip(tail, llm)).toBe(false);
  });

  it('parseCourtesySkip only accepts a boolean', () => {
    expect(parseCourtesySkip('{"skip":true}')).toBe(true);
    expect(parseCourtesySkip('{"needs_reply":false}')).toBeNull();
    expect(parseCourtesySkip('')).toBeNull();
  });

  it('the prompt shows the tail and names the booking confirmation as NOT a goodbye', () => {
    const p = COURTESY_PROMPT(tail);
    expect(p).toContain('[asistente] ¡Con gusto! Te esperamos.\n[cliente] 👍');
    expect(p).toContain('confirmó o agendó una cita');
  });
});
