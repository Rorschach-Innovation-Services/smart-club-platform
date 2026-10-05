import { describe, it, expect } from 'vitest';
import { ApiError, SERIES_CONFLICT_FRIENDLY } from './api';
import {
  describeError,
  isNetworkError,
  isVersionRace,
  networkErrorMessage,
  releaseErrorMessage,
  SEASON_CHANGED_MESSAGE,
  SEASON_EXISTS_MESSAGE,
  STRUCTURE_MISSING_MESSAGE,
  CALENDAR_MISSING_MESSAGE,
  seasonRunConflictMessage,
  seasonRunErrorMessage,
  SETUP_MISSING_MESSAGE,
  startSeasonErrorMessage,
  toastCopy,
} from './error-copy';

describe('isNetworkError', () => {
  it("recognises each browser's fetch failure and a status-0 upload", () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new TypeError('Load failed'))).toBe(true);
    expect(isNetworkError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(
      true,
    );
    expect(isNetworkError(new ApiError(0, 'upload failed — network error'))).toBe(true);
  });

  it('leaves server answers and programming errors alone', () => {
    expect(isNetworkError(new ApiError(500, 'boom'))).toBe(false);
    expect(isNetworkError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(
      false,
    );
  });
});

describe('networkErrorMessage', () => {
  it('says the server was unreachable and what to do', () => {
    expect(networkErrorMessage()).toMatch(/^Couldn't reach the (local API|server)\./);
    expect(networkErrorMessage()).toMatch(/then try again\.$/);
  });
});

describe('isVersionRace', () => {
  it('matches any record’s "changed; refetch" 409 and nothing else', () => {
    expect(isVersionRace(new ApiError(409, 'series changed; refetch'))).toBe(true);
    expect(isVersionRace(new ApiError(409, 'season run changed; refetch'))).toBe(true);
    expect(isVersionRace(new ApiError(400, 'series changed; refetch'))).toBe(false);
    expect(isVersionRace(new ApiError(409, 'a season run with that id already exists'))).toBe(
      false,
    );
  });
});

describe('describeError', () => {
  it('prefers network copy, then the friendly race line, then the server, then the fallback', () => {
    expect(describeError(new TypeError('Failed to fetch'), 'fb')).toBe(networkErrorMessage());
    expect(describeError(new ApiError(409, 'series changed; refetch'), 'fb')).toBe(
      SERIES_CONFLICT_FRIENDLY,
    );
    expect(describeError(new ApiError(400, 'every calendar needs a label'), 'fb')).toBe(
      'every calendar needs a label',
    );
    expect(describeError(new Error('internal'), 'fb')).toBe('fb');
  });
});

describe('season-run writes', () => {
  it('says the season moved under a confirm, instead of the server boilerplate', () => {
    const err = new ApiError(409, 'season run changed; refetch');
    expect(seasonRunConflictMessage(err)).toBe(SEASON_CHANGED_MESSAGE);
    expect(seasonRunErrorMessage(err, 'fb')).not.toContain('refetch');
  });

  it('sends a rebase against a moved structure back to Review changes', () => {
    const err = new ApiError(
      409,
      'the structure changed since you reviewed it; refetch',
      'structure_changed',
    );
    expect(seasonRunConflictMessage(err)).toBe(
      'The operator changed this structure again while you were reviewing it. Close this and open Review changes again to see the latest version.',
    );
  });

  it('leaves other failures to describeError', () => {
    expect(seasonRunConflictMessage(new ApiError(400, 'bad groups'))).toBeNull();
    expect(seasonRunErrorMessage(new ApiError(400, 'bad groups'), 'fb')).toBe('bad groups');
    expect(seasonRunErrorMessage(new TypeError('Failed to fetch'), 'fb')).toBe(
      networkErrorMessage(),
    );
  });
});

describe('startSeasonErrorMessage', () => {
  it('sends a league with no setup to the operator', () => {
    const err = new ApiError(
      400,
      'this league has no season setup yet — ask your operator',
      'setup_missing',
    );
    expect(startSeasonErrorMessage(err)).toBe(
      'This league has no season setup yet — ask your operator to set it up in the operator console.',
    );
    expect(SETUP_MISSING_MESSAGE).toBe(startSeasonErrorMessage(err));
  });

  it('asks for a different label when the season already runs', () => {
    const err = new ApiError(
      409,
      '"2026/27" is already running for "Premier Men"',
      'season_exists',
    );
    expect(startSeasonErrorMessage(err)).toBe(
      'That season label is already running for this league — pick a different label or continue the existing season.',
    );
    expect(SEASON_EXISTS_MESSAGE).toBe(startSeasonErrorMessage(err));
  });

  it('sends a setup whose structure or calendar is gone to the operator', () => {
    const structure = new ApiError(
      400,
      "the league's structure no longer exists",
      'structure_missing',
    );
    expect(startSeasonErrorMessage(structure)).toBe(STRUCTURE_MISSING_MESSAGE);
    expect(STRUCTURE_MISSING_MESSAGE).toMatch(
      /structure that no longer exists — ask your operator/,
    );
    const calendar = new ApiError(
      400,
      "the league's calendar no longer exists",
      'calendar_missing',
    );
    expect(startSeasonErrorMessage(calendar)).toBe(CALENDAR_MISSING_MESSAGE);
    expect(CALENDAR_MISSING_MESSAGE).toMatch(/calendar that no longer exists — ask your operator/);
  });

  it('never shows a code, and leaves every other failure to describeError', () => {
    for (const code of ['setup_missing', 'structure_missing', 'calendar_missing', 'season_exists'])
      expect(startSeasonErrorMessage(new ApiError(400, 'x', code))).not.toContain(code);
    expect(startSeasonErrorMessage(new ApiError(400, 'unknown league'))).toBeNull();
    expect(startSeasonErrorMessage(new Error('boom'))).toBeNull();
  });

  it('is what the start-season toast shows for a coded refusal', () => {
    const err = new ApiError(400, 'x', 'setup_missing');
    expect(
      toastCopy(err, 'Could not start the season', { errorMessage: startSeasonErrorMessage }),
    ).toBe(SETUP_MISSING_MESSAGE);
    const dup = new ApiError(409, 'x', 'season_exists');
    expect(
      toastCopy(dup, 'Could not start the season', { errorMessage: startSeasonErrorMessage }),
    ).toBe(SEASON_EXISTS_MESSAGE);
  });
});

describe('releaseErrorMessage', () => {
  it('says to approve first', () => {
    expect(
      releaseErrorMessage(
        new ApiError(400, 'fixtures must be approved before release', 'not_approved'),
      ),
    ).toBe("These fixtures haven't been approved yet. Approve them, then release.");
  });

  it('keeps any other message, and swaps a network failure for the network line', () => {
    expect(releaseErrorMessage(new Error('Release blocked — …'))).toBe('Release blocked — …');
    expect(releaseErrorMessage(new TypeError('Failed to fetch'))).toBe(networkErrorMessage());
    expect(releaseErrorMessage({})).toBe('Release failed — try again.');
  });
});

describe('toastCopy — what withToast shows', () => {
  it('names the network, not "Could not generate the fixtures", when the API is unreachable', () => {
    expect(toastCopy(new TypeError('Failed to fetch'), 'Could not generate the fixtures')).toBe(
      networkErrorMessage(),
    );
  });

  it('prefers the caller’s structured copy for a coded refusal', () => {
    const err = new ApiError(409, 'stage is awaiting entrants', 'awaiting_entrants');
    expect(toastCopy(err, 'Could not generate', { conflictMessage: () => 'Confirm first.' })).toBe(
      'Confirm first.',
    );
    const notApproved = new ApiError(400, 'fixtures must be approved', 'not_approved');
    expect(
      toastCopy(notApproved, 'Could not update release', { errorMessage: releaseErrorMessage }),
    ).toBe("These fixtures haven't been approved yet. Approve them, then release.");
  });

  it('keeps the existing fallbacks: friendly race line, raw opt-ins, 401, then errMsg', () => {
    const race = new ApiError(409, 'series changed; refetch');
    expect(toastCopy(race, 'x', { rawConflict: true })).toBe(SERIES_CONFLICT_FRIENDLY);
    expect(toastCopy(new ApiError(409, 'user already active'), 'x', { rawConflict: true })).toBe(
      'user already active',
    );
    expect(toastCopy(new ApiError(409, 'anything else'), 'x')).toBe(SERIES_CONFLICT_FRIENDLY);
    expect(toastCopy(new ApiError(404, 'missing'), 'x', { rawClientError: true })).toBe('missing');
    expect(toastCopy(new ApiError(401, 'Your session has expired'), 'x')).toBe(
      'Your session has expired',
    );
    expect(toastCopy(new ApiError(500, 'boom'), 'Could not save')).toBe('Could not save');
    expect(toastCopy(new ApiError(500, 'boom'), undefined)).toBe('boom');
  });
});
