// Pure business logic mirroring SPEC.md's "Core business logic" section.
// Kept isolated/pure so it can be unit-tested without any DOM/fetch globals —
// same rule the backend's Apps Script logic follows.

function normalize(str) {
  return (str || '').trim().toLowerCase();
}

/**
 * Given the full raw movie list (each with {title, prequel, watched}),
 * return the same movies annotated with `eligible` and `waitingOn` per
 * the spec:
 *
 *   eligible(movie) =
 *        movie.watched === false
 *     && (movie.prequel is empty
 *         OR the row whose title matches movie.prequel has watched === true)
 *
 *   waitingOn = the raw prequel text, if the movie is ineligible solely
 *   because of an unwatched/unresolved prequel; otherwise null. A dangling
 *   prequel reference (no matching row) is treated as NOT eligible
 *   (fail closed), and still reports waitingOn so the UI can explain why.
 */
export function computeMovieFields(movies) {
  const findByTitle = (title) =>
    movies.find((m) => normalize(m.title) === normalize(title));

  return movies.map((movie) => {
    let eligible;
    let waitingOn = null;

    if (movie.watched) {
      eligible = false;
    } else if (!movie.prequel) {
      eligible = true;
    } else {
      const prequelRow = findByTitle(movie.prequel);
      if (prequelRow && prequelRow.watched) {
        eligible = true;
      } else {
        eligible = false;
        waitingOn = movie.prequel;
      }
    }

    return { ...movie, eligible, waitingOn };
  });
}
