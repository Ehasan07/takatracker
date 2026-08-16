export * from './normalise.js';
export * from './zip.js';
export * from './xlsx.js';
export * from './pdf-table.js';

/* The two fixture builders are exported on purpose.
 *
 * They make a real `.xlsx` and a real `.pdf` out of a few lines of literal
 * data, and they are used by this package's own tests *and* by the API's
 * end-to-end suite, which has to post an actual file at an actual endpoint. The
 * alternative was a checked-in binary — which nobody can read in a diff, and
 * whose contents could only be confirmed with the very reader under test. */
export * from './xlsx.fixture.js';
export * from './pdf.fixture.js';
