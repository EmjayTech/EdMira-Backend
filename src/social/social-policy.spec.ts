import { CONNECTION_STATUSES, ConnectionAction, isLive, pairKey, transition } from './social-policy';

describe('connection state machine', () => {
  it('lets only the recipient accept or decline a pending request', () => {
    expect(transition('pending', 'accept', 'recipient')).toBe('accepted');
    expect(transition('pending', 'decline', 'recipient')).toBe('declined');
    expect(transition('pending', 'accept', 'requester')).toBeNull(); // can't accept your own request
    expect(transition('pending', 'decline', 'requester')).toBeNull();
  });

  it('lets only the requester cancel, and either side remove a connection', () => {
    expect(transition('pending', 'cancel', 'requester')).toBe('cancelled');
    expect(transition('pending', 'cancel', 'recipient')).toBeNull();
    expect(transition('accepted', 'remove', 'requester')).toBe('removed');
    expect(transition('accepted', 'remove', 'recipient')).toBe('removed');
  });

  it('never moves out of an ended state', () => {
    const actions: ConnectionAction[] = ['accept', 'decline', 'cancel', 'remove'];
    for (const status of ['declined', 'cancelled', 'expired', 'removed', 'blocked'] as const) {
      for (const action of actions) {
        expect(transition(status, action, 'requester')).toBeNull();
        expect(transition(status, action, 'recipient')).toBeNull();
      }
    }
    expect(transition('accepted', 'accept', 'recipient')).toBeNull();
  });

  it('treats only pending and accepted as live', () => {
    expect(CONNECTION_STATUSES.filter(isLive)).toEqual(['pending', 'accepted']);
  });

  it('gives a pair the same key in both directions', () => {
    expect(pairKey('a1', 'b2')).toBe(pairKey('b2', 'a1'));
  });
});

import { challengeWinner } from './schemas/challenge.schema';

describe('challenge winner', () => {
  it('goes to the higher score, then the faster time', () => {
    expect(challengeWinner({ challenger: { score: 80, timeMs: 90_000 }, opponent: { score: 70, timeMs: 10_000 } })).toBe('challenger');
    expect(challengeWinner({ challenger: { score: 80, timeMs: 90_000 }, opponent: { score: 80, timeMs: 60_000 } })).toBe('opponent');
    expect(challengeWinner({ challenger: { score: 80, timeMs: 60_000 }, opponent: { score: 80, timeMs: 60_000 } })).toBe('tie');
  });
});
