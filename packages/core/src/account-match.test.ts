import { describe, expect, it } from 'vitest';
import { matchAccount, type AccountMatchCandidate } from './account-match.js';

const UCB_CURRENT: AccountMatchCandidate = {
  id: 'acc_ucb',
  name: 'UCB Bank',
  institution: 'United Commercial Bank',
  accountNumberMasked: '****6948',
  matchHints: [],
};

const UCB_CARD: AccountMatchCandidate = {
  id: 'acc_card',
  name: 'UCB Credit Card',
  institution: 'United Commercial Bank',
  accountNumberMasked: null,
  matchHints: ['Card#0570'],
};

const BKASH: AccountMatchCandidate = {
  id: 'acc_bkash',
  name: 'bKash',
  institution: null,
  accountNumberMasked: null,
  matchHints: ['bKash'],
};

const ALL = [UCB_CURRENT, UCB_CARD, BKASH];

describe('matchAccount', () => {
  it('matches the account number the parser read', () => {
    expect(matchAccount(ALL, { accountHint: '6948', sender: 'UCB.' })).toEqual({
      accountId: 'acc_ucb',
      by: 'number',
      matchedOn: '****6948',
    });
  });

  it('reads a number out of a hint the owner typed with punctuation', () => {
    const typed = { ...UCB_CURRENT, accountNumberMasked: null, matchHints: ['A/C (***6948)'] };
    expect(matchAccount([typed, BKASH], { accountHint: '6948' })?.accountId).toBe('acc_ucb');
  });

  it('matches a card by its hint when the account has no masked number', () => {
    expect(matchAccount(ALL, { accountHint: '0570', sender: 'UCB.' })?.accountId).toBe('acc_card');
  });

  it('does not match on a shared three-digit tail', () => {
    expect(matchAccount(ALL, { accountHint: '1948' })).toBeNull();
  });

  it('falls back to a word hint when no number was read', () => {
    expect(matchAccount(ALL, { sender: 'bKash', body: 'You have received Tk 500' })).toEqual({
      accountId: 'acc_bkash',
      by: 'hint',
      matchedOn: 'bKash',
    });
  });

  it('finds a word hint in the body when the sender does not carry it', () => {
    const dbbl = { id: 'acc_dbbl', name: 'DBBL', matchHints: ['DBBL'] };
    expect(
      matchAccount([dbbl, BKASH], { sender: '16419', body: 'DBBL debit BDT 100' })?.accountId,
    ).toBe('acc_dbbl');
  });

  it('returns nothing when two accounts of one bank match the sender', () => {
    expect(matchAccount(ALL, { sender: 'UCB.', body: 'BDT 4,000.00 debited' })).toBeNull();
  });

  it('matches the sole account of a bank by its sender', () => {
    expect(matchAccount([UCB_CURRENT, BKASH], { sender: 'UCB.' })).toEqual({
      accountId: 'acc_ucb',
      by: 'sender',
      matchedOn: 'UCB Bank',
    });
  });

  it('never matches an account name against the message body', () => {
    const transfers = { id: 'acc_x', name: 'Transfer', matchHints: [] };
    expect(
      matchAccount([transfers], { sender: '16419', body: 'I Banking EFTN Transfer Debit Retail' }),
    ).toBeNull();
  });

  it('prefers the number over a word hint that points elsewhere', () => {
    const wrong = { id: 'acc_w', name: 'Other', matchHints: ['UCB'] };
    expect(
      matchAccount([UCB_CURRENT, wrong], { accountHint: '6948', sender: 'UCB.' })?.accountId,
    ).toBe('acc_ucb');
  });

  it('returns nothing for an empty message and no accounts', () => {
    expect(matchAccount([], { accountHint: '6948' })).toBeNull();
    expect(matchAccount(ALL, {})).toBeNull();
  });
});
