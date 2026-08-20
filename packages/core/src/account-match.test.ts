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

  it('reads the account number out of the account name', () => {
    /* How people actually name accounts. Refusing to read it would have the
       best-labelled account in the workspace fail to match its own alerts. */
    const named = { id: 'acc_named', name: 'UCB SALARY- 1043204000006948 |Tejgone Branch' };
    expect(matchAccount([named, BKASH], { accountHint: '6948' })?.accountId).toBe('acc_named');
  });

  it('reads a Bengali-numeral account number in a name', () => {
    const dps = { id: 'acc_dps', name: '১০কে ইসলামী ডিপিএস — বিকাশ ১৭৮৩০৬০৪০৬০৭০' };
    expect(matchAccount([dps], { accountHint: '6070' })?.accountId).toBe('acc_dps');
  });

  it('does not read a year and a round figure in a name as an account number', () => {
    /* `CBL-Term Loan 2019 (900k)` concatenates to 2019900, whose last four are
       9900 — a number that appears nowhere. */
    const loan = { id: 'acc_loan', name: 'CBL-Term Loan 2019 (900k)' };
    expect(matchAccount([loan], { accountHint: '9900' })).toBeNull();
  });

  it('reads a number masked in the middle, not the head of it', () => {
    const city = { id: 'acc_city', name: 'THE CITY BANK 2101696107001' };
    expect(matchAccount([city], { accountHint: '1422***8001' })).toBeNull();
    expect(matchAccount([city], { accountHint: '2101***7001' })?.accountId).toBe('acc_city');
  });

  it('will not fall back to the sender when the account it names has a different number', () => {
    /* The alert quotes 8001 and this account is 7001. The app knows that
       account's number, so "CITY BANK" is not evidence — it is a bank, and a
       bank holds many accounts. */
    const city = { id: 'acc_city', name: 'THE CITY BANK 2101696107001', matchHints: ['***7001'] };
    expect(
      matchAccount([city], {
        accountHint: '8001',
        sender: 'CITY BANK',
        body: 'Tk. 60,000 Withdrawal',
      }),
    ).toBeNull();
  });

  it('still matches the sender for an account whose number is not on file', () => {
    /* Nothing is known about this account to contradict the message, so a
       workspace that has never typed a number in is no worse off. */
    const plain = { id: 'acc_plain', name: 'বিকাশ', matchHints: ['bKash'] };
    expect(
      matchAccount([plain], { accountHint: '0870', sender: 'bKash', body: 'Payment of Tk 551.00' })
        ?.accountId,
    ).toBe('acc_plain');
  });

  it('separates three wallets on one phone number by their sender', () => {
    const wallets = [
      { id: 'acc_bkash', name: 'Bkash-01717455764' },
      { id: 'acc_nagad', name: 'Nagad-01717455764' },
      { id: 'acc_upay', name: 'upay-01717455764' },
    ];
    expect(matchAccount(wallets, { accountHint: '5764', sender: 'bKash' })?.accountId).toBe(
      'acc_bkash',
    );
    expect(matchAccount(wallets, { accountHint: '5764', sender: '16216' })).toBeNull();
  });

  it('keeps a hint that appears verbatim in the message, number mismatch or not', () => {
    /* The card is filed under the customer id its own alerts print. Comparing
       that id to a card number and excluding the account for failing would
       throw away the strongest evidence there is. */
    const card = {
      id: 'acc_ucbl',
      name: 'UCBL-BDT-Master Card-714043',
      matchHints: ['ID#1659262'],
    };
    const match = matchAccount([card], {
      accountHint: '8386',
      sender: 'UCB.',
      body: 'Card# 8386 purchase BDT 900.00. ID#1659262',
    });
    expect(match).toEqual({ accountId: 'acc_ucbl', by: 'hint', matchedOn: 'ID#1659262' });
  });
});
