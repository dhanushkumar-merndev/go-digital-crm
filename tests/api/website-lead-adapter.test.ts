import { describe, expect, it } from 'vitest';
import {
  defaultWebsiteWidgetConfig,
  LEAD_API_KEY_PATTERN,
  mapWebsiteChatAnswers,
  normalizeWebsiteOrigin,
  normalizeWebsitePhone,
  parseLeadApiPayload,
  parseWebsiteWidgetConfig,
  websiteEmbedSnippet,
  websiteQuestion,
  type WebsiteWidgetConfig,
} from '../../src/lib/providers/website-lead-adapter';

const context = {
  models: ['Nexon', 'Harrier'],
  branches: [
    { id: 'branch-a', name: 'MG Road' },
    { id: 'branch-b', name: 'Whitefield' },
  ],
};

function config(overrides: Partial<WebsiteWidgetConfig> = {}): WebsiteWidgetConfig {
  const parsed = parseWebsiteWidgetConfig({
    ...defaultWebsiteWidgetConfig(),
    allowed_origins: ['https://dealer.example'],
    ...overrides,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe('website widget configuration', () => {
  it('accepts the default flow once a domain is allowed', () => {
    expect(config().questions.map((question) => question.field)).toEqual([
      'customer_name',
      'phone',
      'interested_model',
      'budget',
      'purchase_timeline',
      'preferred_branch',
      'exchange_required',
      'finance_required',
      'test_drive_required',
    ]);
  });

  it('refuses an enabled widget without an allowed domain', () => {
    const parsed = parseWebsiteWidgetConfig(defaultWebsiteWidgetConfig());
    expect(parsed.ok).toBe(false);
  });

  it('allows an API-only connection without domains', () => {
    const parsed = parseWebsiteWidgetConfig({
      ...defaultWebsiteWidgetConfig(),
      widget_enabled: false,
    });
    expect(parsed.ok).toBe(true);
  });

  it('normalises pasted domains and rejects paths, http and junk', () => {
    expect(normalizeWebsiteOrigin('WWW.Dealer.example/')).toBe('https://www.dealer.example');
    expect(normalizeWebsiteOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeWebsiteOrigin('http://dealer.example')).toBeNull();
    expect(normalizeWebsiteOrigin('https://dealer.example/contact')).toBeNull();
    expect(normalizeWebsiteOrigin('javascript:alert(1)')).toBeNull();
  });

  it('always keeps name and phone required and present', () => {
    const withoutPhone = defaultWebsiteWidgetConfig().questions.filter(
      (question) => question.field !== 'phone',
    );
    expect(
      parseWebsiteWidgetConfig({
        ...defaultWebsiteWidgetConfig(),
        allowed_origins: ['https://dealer.example'],
        questions: withoutPhone,
      }).ok,
    ).toBe(false);
    const optionalName = config({
      questions: [
        { ...websiteQuestion('customer_name'), required: false },
        websiteQuestion('phone'),
      ],
    });
    expect(optionalName.questions[0].required).toBe(true);
  });

  it('rejects a field asked twice and keeps budget options fixed', () => {
    const questions = defaultWebsiteWidgetConfig().questions;
    expect(
      parseWebsiteWidgetConfig({
        ...defaultWebsiteWidgetConfig(),
        allowed_origins: ['https://dealer.example'],
        questions: [...questions, { ...websiteQuestion('budget'), id: 'budget_2' }],
      }).ok,
    ).toBe(false);
    const tampered = config({
      questions: questions.map((question) =>
        question.field === 'budget' ? { ...question, options: ['Free car'] } : question,
      ),
    });
    expect(
      tampered.questions.find((question) => question.field === 'budget')?.options,
    ).not.toContain('Free car');
  });
});

describe('website chat answers', () => {
  const answers = {
    customer_name: '  Ravi   Kumar ',
    phone: '098765 43210',
    interested_model: 'Nexon',
    budget: '₹5–10 lakh',
    purchase_timeline: 'Within 1 month',
    preferred_branch: 'branch-b',
    exchange_required: 'no',
    finance_required: true,
    test_drive_required: 'yes',
  };

  it('maps answers onto the lead, its requirements and a transcript', () => {
    const mapped = mapWebsiteChatAnswers(config(), answers, context);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value).toMatchObject({
      customer_name: 'Ravi Kumar',
      phone: '+919876543210',
      interested_model: 'Nexon',
      branch_id: 'branch-b',
      requirements: {
        budget_min: 500_000,
        budget_max: 1_000_000,
        purchase_timeline: 'Within 1 month',
        exchange_required: false,
        finance_required: true,
        test_drive_required: true,
      },
    });
    expect(mapped.value.transcript.find((entry) => entry.id === 'preferred_branch')?.answer).toBe(
      'Whitefield',
    );
  });

  it('rejects a showroom, model or option outside the configured lists', () => {
    for (const [key, value] of [
      ['preferred_branch', 'branch-other-org'],
      ['interested_model', 'Lamborghini'],
      ['budget', 'Unlimited'],
    ] as const) {
      const mapped = mapWebsiteChatAnswers(config(), { ...answers, [key]: value }, context);
      expect(mapped.ok).toBe(false);
      if (!mapped.ok) expect(mapped.question_id).toBe(key);
    }
  });

  it('treats a skipped optional answer as absent and a missing required one as an error', () => {
    const skipped = mapWebsiteChatAnswers(config(), { ...answers, budget: '' }, context);
    expect(skipped.ok && skipped.value.requirements.budget_min).toBeUndefined();
    const missing = mapWebsiteChatAnswers(config(), { ...answers, phone: '' }, context);
    expect(missing.ok).toBe(false);
  });

  it('accepts only real mobile numbers', () => {
    expect(normalizeWebsitePhone('+91 98765-43210')).toBe('+919876543210');
    expect(normalizeWebsitePhone('919876543210')).toBe('+919876543210');
    expect(normalizeWebsitePhone('12345')).toBeNull();
    expect(normalizeWebsitePhone('1234567890')).toBeNull();
    expect(normalizeWebsitePhone('<script>')).toBeNull();
  });
});

describe('Lead API payload', () => {
  it('parses a full payload', () => {
    const parsed = parseLeadApiPayload({
      customer_name: 'Ravi Kumar',
      phone: '9876543210',
      email: 'Ravi@Example.com',
      branch_code: 'BLR-01',
      requirements: { budget_min: 800000, budget_max: 1200000, finance_required: true },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.value).toMatchObject({
        phone: '+919876543210',
        email: 'ravi@example.com',
        requirements: { budget_min: 800000, budget_max: 1200000, finance_required: true },
      });
  });

  it('rejects bad identity, inverted budgets and wrong types', () => {
    expect(parseLeadApiPayload({ customer_name: 'R', phone: '9876543210' }).ok).toBe(false);
    expect(parseLeadApiPayload({ customer_name: 'Ravi', phone: 'abc' }).ok).toBe(false);
    expect(
      parseLeadApiPayload({
        customer_name: 'Ravi',
        phone: '9876543210',
        requirements: { budget_min: 10, budget_max: 5 },
      }).ok,
    ).toBe(false);
    expect(
      parseLeadApiPayload({
        customer_name: 'Ravi',
        phone: '9876543210',
        requirements: { finance_required: 'yes' },
      }).ok,
    ).toBe(false);
    expect(parseLeadApiPayload([]).ok).toBe(false);
  });
});

describe('keys and snippet', () => {
  it('recognises issued API keys and splits out the lookup prefix', () => {
    const match = LEAD_API_KEY_PATTERN.exec(
      'gdm_live_ZNxcagGHpf_q9Vh2a-Xb_c3dEf4GhIjKlMnOpQrStUvWxYz012345',
    );
    expect(match?.[1]).toBe('ZNxcagGHpf');
    expect(LEAD_API_KEY_PATTERN.test('wpk_publicwidgetkeyvalue12345678')).toBe(false);
  });

  it('builds the embed snippet from the CRM origin', () => {
    expect(websiteEmbedSnippet('https://crm.example/', 'wpk_abc')).toBe(
      '<script src="https://crm.example/widget/v1/gdm-chat.js" data-key="wpk_abc" async></script>',
    );
  });
});
