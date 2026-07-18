# S7-03 explanation artifacts

The additive layout is `<canonical-run-directory>/explanation/`. It contains
the five canonical JSON artifacts, `REPORT.md`, and `evidence-index.json`.
All public references use run-relative POSIX paths. JSON is serialized with
the repository canonical serializer; arrays are explicitly sorted by stable
IDs where applicable. Publication builds a same-directory temporary directory
and renames it once, with exclusive file creation and no replacement of an
existing explanation directory.

The application service validates the existing Stage 6 run first, invokes the
S7-02 analyzer in memory from persisted condition context manifests, bounded
Stage 4 compilation JSON, and persisted Stage 5/6 evidence, writes only this additive directory, reads every
artifact back, and verifies lengths, hashes, references, report derivation,
and the aggregate index hash. Limited runs are bounded and non-causal;
invalid runs contain no helped/hurt attribution. The report is rendered only
from canonical result and summary data.
