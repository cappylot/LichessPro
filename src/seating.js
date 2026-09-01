/**
 * Which seat a player claims, and by which route.
 *
 * A match has exactly two seats and they are NOT interchangeable:
 *
 *   seat 'a' — the host. Signs in through OAuth, and is the CHALLENGER: the
 *              game is created with this seat's token, so the colour chosen
 *              when the match was made applies to this player.
 *   seat 'b' — the opponent. Seated by the host pasting their API token.
 *
 * Each route therefore pins its seat rather than taking "the first empty one".
 * Picking the first empty seat looks equivalent and is not: if the host pastes
 * their opponent's token before signing in themselves, the opponent lands in
 * seat 'a' and becomes the challenger, silently inverting both roles and the
 * colour choice.
 */

export const SEATS = ['a', 'b'];
export const HOST_SEAT = 'a';
export const OPPONENT_SEAT = 'b';

/** Which seat, if any, this browser owns. */
export function seatOf(match, clientId) {
  if (!clientId) return null;
  for (const key of SEATS) {
    if (match.seats[key]?.clientId === clientId) return key;
  }
  return null;
}

export function bothSeatsFilled(match) {
  return SEATS.every((key) => Boolean(match.seats[key]?.token));
}

/**
 * Seat for a player arriving through OAuth: always the host seat.
 *
 * @returns {{seat: string}|{error: string}}
 */
export function seatForOAuth(match, clientId) {
  // Always the host seat -- never "the seat this browser owns". The host's
  // cookie is stamped on seat 'b' too when they paste their opponent's token,
  // so reusing the owned seat would drop the host into the opponent's chair if
  // they pasted the token before signing in.
  if (seatOf(match, clientId) === HOST_SEAT) return { seat: HOST_SEAT }; // re-authenticating

  if (match.seats[HOST_SEAT]) {
    return {
      error: `This match already has a challenger signed in (${match.seats[HOST_SEAT].username}). Create a new match to play again.`,
    };
  }
  return { seat: HOST_SEAT };
}

/**
 * Seat for a pasted access token: always the opponent seat, never the host's.
 *
 * @returns {{seat: string}|{error: string}}
 */
export function seatForToken(match) {
  if (match.seats[OPPONENT_SEAT]) {
    return {
      error: `This match already has an opponent (${match.seats[OPPONENT_SEAT].username}). Create a new match to play someone else.`,
    };
  }
  return { seat: OPPONENT_SEAT };
}
