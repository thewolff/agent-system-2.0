-- agent-system 2.0 ledger schema, version 6.
-- Human documentation: ledger/SCHEMA.md. Ruling: SPEC-2.0.md § B2 ("Ruled 2026-09-24").
--
-- The state-order and provenance rules live HERE, as CHECK constraints and triggers, so every
-- writer of this file is bound by them: the TypeScript module (ledger/src/), a second tool, or a
-- person at the sqlite3 prompt. The module adds convenience, retries and ids; it adds no rule the
-- file does not already enforce.
--
-- Two facts every writer must know:
--   1. foreign_keys is a per-connection setting, not stored in the file; the sqlite3 CLI runs with
--      it off. The existence rules that matter (a row's workload, slice and question exist and
--      agree) are therefore ALSO triggers, which fire regardless of that setting.
--   2. journal_mode=WAL IS stored in the file. It is set below and persists for every connection.
--
-- Timestamps are ISO-8601 UTC with milliseconds ('2026-09-28T19:40:18.444Z'), enforced by GLOB,
-- so text comparison is time comparison. The shape is what JavaScript's Date#toISOString() and
-- SQLite's strftime('%Y-%m-%dT%H:%M:%fZ','now') both produce.
--
-- Every mutable row carries: created_by / created_at (who wrote it first, when), changed_by /
-- changed_at (who wrote it last, when), and rev. An UPDATE must set rev = rev + 1 and a changed_at
-- no earlier than the old one; an UPDATE that does neither is refused as unstamped. Rows are never
-- deleted, and never replaced: an INSERT that reuses an existing id (or rowid, or provenance seq)
-- is refused whatever its conflict clause (INSERT OR REPLACE, REPLACE, OR IGNORE, UPSERT), because
-- REPLACE deletes the old row without firing delete triggers when recursive_triggers is off (the
-- sqlite3 CLI default). Every INSERT and UPDATE appends a provenance row (workload, lane instance,
-- time) through an AFTER trigger, so the provenance log cannot be skipped by any writer.

PRAGMA journal_mode = WAL;

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- workloads: one unit of work Jo handed over (brief, stakes, mode), who holds it, open/closed.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workloads (
  id                 TEXT PRIMARY KEY CHECK (id GLOB 'wl-?*'),
  brief              TEXT NOT NULL CHECK (length(trim(brief)) > 0),
  stakes             TEXT NOT NULL CHECK (stakes IN ('throwaway', 'normal', 'production')),
  mode               TEXT NOT NULL CHECK (mode IN ('autonomous', 'user-driven')),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  holder             TEXT CHECK (holder IS NULL OR length(trim(holder)) > 0),
  holder_lease_until TEXT CHECK (holder_lease_until IS NULL OR holder_lease_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  closed_at          TEXT CHECK (closed_at IS NULL OR closed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  created_by         TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at         TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  changed_by         TEXT NOT NULL CHECK (length(trim(changed_by)) > 0),
  changed_at         TEXT NOT NULL CHECK (changed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  rev                INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (status = 'open' OR holder IS NULL),
  CHECK (holder IS NOT NULL OR holder_lease_until IS NULL),
  CHECK (changed_at >= created_at)
);

-- ---------------------------------------------------------------------------------------------
-- slices: a leaf unit of a workload (task, done-condition, inputs). Closed only on an artifact.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE slices (
  id             TEXT PRIMARY KEY CHECK (id GLOB 'sl-?*'),
  workload_id    TEXT NOT NULL REFERENCES workloads(id),
  task           TEXT NOT NULL CHECK (length(trim(task)) > 0),
  done_condition TEXT NOT NULL CHECK (length(trim(done_condition)) > 0),
  inputs         TEXT NOT NULL CHECK (length(trim(inputs)) > 0),
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'paused', 'done', 'cancelled')),
  artifact       TEXT,
  created_by     TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at     TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  changed_by     TEXT NOT NULL CHECK (length(trim(changed_by)) > 0),
  changed_at     TEXT NOT NULL CHECK (changed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  rev            INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
  CHECK ((state = 'done') = (artifact IS NOT NULL AND length(trim(artifact)) > 0)),
  CHECK (state = 'done' OR artifact IS NULL),
  CHECK (changed_at >= created_at)
);
CREATE INDEX slices_workload_state ON slices (workload_id, state);

-- ---------------------------------------------------------------------------------------------
-- messages: the four-state queue, held -> delivered -> consumed -> acted-on, one step at a time.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE messages (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'msg-?*'),
  workload_id TEXT NOT NULL REFERENCES workloads(id),
  slice_id    TEXT REFERENCES slices(id),
  sender      TEXT NOT NULL CHECK (length(trim(sender)) > 0),
  recipient   TEXT NOT NULL CHECK (length(trim(recipient)) > 0),
  body        TEXT NOT NULL CHECK (length(trim(body)) > 0),
  state       TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'delivered', 'consumed', 'acted-on')),
  created_by  TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at  TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  changed_by  TEXT NOT NULL CHECK (length(trim(changed_by)) > 0),
  changed_at  TEXT NOT NULL CHECK (changed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  rev         INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
  CHECK (changed_at >= created_at)
);
-- created_at is the enqueue time; the oldest-held query reads this index.
CREATE INDEX messages_state_created ON messages (state, created_at);

-- ---------------------------------------------------------------------------------------------
-- instructions: Jo's instructions to a lane (SPEC § B5), answers and withdrawals of questions
-- (§ B3 item 5), and mode flips (§ B13.1). Append-only: never updated, never deleted.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE instructions (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'in-?*'),
  workload_id TEXT NOT NULL REFERENCES workloads(id),
  slice_id    TEXT REFERENCES slices(id),
  kind        TEXT NOT NULL CHECK (kind IN ('instruction', 'answer', 'withdrawal', 'mode-flip')),
  question_id TEXT REFERENCES questions(id),
  -- For a withdrawal only: what happens to the paused slice once no question on it is open.
  disposition TEXT CHECK (disposition IS NULL OR disposition IN ('cancel', 'replan')),
  channel     TEXT NOT NULL CHECK (channel IN ('surface', 'direct')),
  author      TEXT NOT NULL CHECK (length(trim(author)) > 0),
  body        TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_by  TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at  TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK ((kind IN ('answer', 'withdrawal')) = (question_id IS NOT NULL)),
  CHECK ((kind = 'withdrawal') = (disposition IS NOT NULL)),
  CHECK (kind <> 'mode-flip' OR body IN ('autonomous', 'user-driven'))
);
CREATE INDEX instructions_workload_created ON instructions (workload_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- questions: a lane-raised question (§ B3 item 5). Stable id; pauses only its slice; resolved
-- only by an answer or withdrawal instruction that names it.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE questions (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'q-?*'),
  workload_id TEXT NOT NULL REFERENCES workloads(id),
  slice_id    TEXT NOT NULL REFERENCES slices(id),
  body        TEXT NOT NULL CHECK (length(trim(body)) > 0),
  options     TEXT NOT NULL CHECK (json_valid(options) AND json_type(options) = 'array' AND json_array_length(options) >= 2),
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'withdrawn')),
  resolved_by TEXT REFERENCES instructions(id),
  created_by  TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at  TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  changed_by  TEXT NOT NULL CHECK (length(trim(changed_by)) > 0),
  changed_at  TEXT NOT NULL CHECK (changed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  rev         INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
  CHECK ((state = 'open') = (resolved_by IS NULL)),
  CHECK (changed_at >= created_at)
);
CREATE INDEX questions_slice_state ON questions (slice_id, state);
CREATE INDEX questions_workload_state ON questions (workload_id, state);

-- ---------------------------------------------------------------------------------------------
-- routings: one row per dispatch (SPEC § A1.3, § B4), written when its outcome is known: the
-- classifier's answer, the tier it computed (pull-up for low confidence, pull-down for stakes), the
-- model row it used, and what actually happened. outcome is 'ran' (every model that answered was
-- on the tier row), 'refused-out-of-row' (one was not; the hand's output was withheld),
-- 'refused-no-usable-model' (the spawn was refused, nothing ran) or 'refused-model-unknown' (no
-- answering model could be read, so the output was withheld). ran_models lists the models that
-- answered, first-seen order; NULL exactly when none was read. A fact, so append-only. spawn_key is
-- the key the spawn event carried (the requested name for a blocking spawn, the allocated agent id
-- for an async one). session_root and agent_id are the hand's durable identity (version 5, astra
-- review 4 B1/S1): the lane's session root (its session file without `.jsonl`, the directory its
-- hands' session files live in) and the agent id OMP finally allocated, so a hand is
-- `<session_root>/<agent_id>.jsonl`. agent_id is NULL exactly for a refused spawn (no hand ran), and
-- one root never holds two rows for one agent id. Pull-up from = classified_tier; pull-down
-- from = coalesce(pull_up_to, classified_tier); both derivable, so not stored. Schema version 5.
--
-- A model name, root or agent id is "blank" when it is empty after trimming every character
-- JavaScript's String#trim removes (Unicode White_Space-class separators, tab, newline, CR, VT, FF,
-- NBSP, BOM): sqlite's one-argument trim() removes spaces only, so a tab-only name passed (astra
-- review 4 N1). The same set is spelled out wherever a blank check reads these columns.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE routings (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'rt-?*'),
  workload_id     TEXT NOT NULL REFERENCES workloads(id),
  slice_id        TEXT NOT NULL REFERENCES slices(id),
  spawn_key       TEXT CHECK (spawn_key IS NULL OR length(trim(spawn_key)) > 0),
  session_root    TEXT NOT NULL CHECK (length(trim(session_root, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0),
  agent_id        TEXT CHECK (agent_id IS NULL OR length(trim(agent_id, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0),
  kind            TEXT NOT NULL CHECK (kind IN ('locate', 'understand', 'change-small', 'change-large', 'judge')),
  confidence      REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  probabilities   TEXT NOT NULL CHECK (json_valid(probabilities)),
  classified_tier TEXT NOT NULL CHECK (classified_tier IN ('fast', 'standard', 'strong', 'deep')),
  pull_up_to      TEXT CHECK (pull_up_to IS NULL OR pull_up_to IN ('standard', 'strong', 'deep')),
  stakes          TEXT CHECK (stakes IS NULL OR stakes IN ('throwaway', 'normal', 'production')),
  pull_down_to    TEXT CHECK (pull_down_to IS NULL OR pull_down_to IN ('fast', 'standard', 'strong')),
  tier            TEXT NOT NULL CHECK (tier IN ('fast', 'standard', 'strong', 'deep')),
  models          TEXT NOT NULL CHECK (json_valid(models) AND json_type(models) = 'array'),
  model           TEXT,
  judge_model     TEXT NOT NULL CHECK (length(trim(judge_model)) > 0),
  outcome         TEXT NOT NULL CHECK (outcome IN ('ran', 'refused-out-of-row', 'refused-no-usable-model', 'refused-model-unknown')),
  ran_models      TEXT CHECK (ran_models IS NULL OR (json_valid(ran_models) AND json_type(ran_models) = 'array' AND json_array_length(ran_models) > 0)),
  created_by      TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at      TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- The usable row at spawn is empty exactly when the spawn found none; model is its first entry.
  CHECK ((json_array_length(models) = 0) = (outcome = 'refused-no-usable-model')),
  CHECK (model IS json_extract(models, '$[0]')),
  -- A model was read exactly when the outcome judged one.
  CHECK ((ran_models IS NOT NULL) = (outcome IN ('ran', 'refused-out-of-row'))),
  -- A hand ran (and so has an allocated agent id) exactly when the spawn was not refused.
  CHECK ((agent_id IS NULL) = (outcome = 'refused-no-usable-model'))
);
CREATE INDEX routings_workload_created ON routings (workload_id, created_at);
CREATE INDEX routings_hand ON routings (session_root, agent_id);

-- ---------------------------------------------------------------------------------------------
-- entries: lane-written facts the gates need (P-11): a wake verified read (row 7), a
-- mode-effective acknowledgement (mode row), a named assumption (question row), a reserved
-- action raised to Jo (row 6). Not Jo's words, so not instructions. Append-only. Schema version 3; unchanged in 4.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE entries (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'en-?*'),
  workload_id TEXT NOT NULL REFERENCES workloads(id),
  slice_id    TEXT REFERENCES slices(id),
  kind        TEXT NOT NULL CHECK (kind IN ('wake-read', 'mode-effective', 'assumption', 'reserved-request')),
  body        TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_by  TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at  TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
CREATE INDEX entries_by_workload ON entries (workload_id, kind, created_at);

-- ---------------------------------------------------------------------------------------------
-- provenance: append-only log of every write to the tables above, written by triggers.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE provenance (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL CHECK (at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  workload_id   TEXT NOT NULL REFERENCES workloads(id),
  lane_instance TEXT NOT NULL CHECK (length(trim(lane_instance)) > 0),
  tbl           TEXT NOT NULL CHECK (tbl IN ('workloads', 'slices', 'messages', 'instructions', 'questions', 'routings', 'entries')),
  row_id        TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('insert', 'update')),
  detail        TEXT
);
CREATE INDEX provenance_workload_at ON provenance (workload_id, at);

-- =============================================================================================
-- Rules common to every mutable table: born at rev 0 with changed_* = created_*; an update is
-- stamped (rev + 1, changed_at not earlier); identity and provenance columns never change;
-- nothing is deleted; no identity is ever inserted twice.
-- =============================================================================================

-- No replacement. A BEFORE INSERT trigger fires before conflict resolution, so these refuse a
-- reused identity under every conflict algorithm. In a BEFORE INSERT trigger NEW.rowid (NEW.seq)
-- is -1 when the writer did not name one, so the rowid clause also matches a stored rowid of -1;
-- that is why the *_positive_identity triggers below make a nonpositive stored rowid or seq
-- impossible. With none stored, the clause only matches an explicit rowid already taken.
CREATE TRIGGER workloads_insert_new_identity BEFORE INSERT ON workloads
WHEN EXISTS (SELECT 1 FROM workloads WHERE id = NEW.id OR rowid = NEW.rowid)
BEGIN SELECT RAISE(ABORT, 'ledger rows are never replaced: that id is already in use'); END;
CREATE TRIGGER slices_insert_new_identity BEFORE INSERT ON slices
WHEN EXISTS (SELECT 1 FROM slices WHERE id = NEW.id OR rowid = NEW.rowid)
BEGIN SELECT RAISE(ABORT, 'ledger rows are never replaced: that id is already in use'); END;
CREATE TRIGGER messages_insert_new_identity BEFORE INSERT ON messages
WHEN EXISTS (SELECT 1 FROM messages WHERE id = NEW.id OR rowid = NEW.rowid)
BEGIN SELECT RAISE(ABORT, 'ledger rows are never replaced: that id is already in use'); END;
CREATE TRIGGER instructions_insert_new_identity BEFORE INSERT ON instructions
WHEN EXISTS (SELECT 1 FROM instructions WHERE id = NEW.id OR rowid = NEW.rowid)
BEGIN SELECT RAISE(ABORT, 'ledger rows are never replaced: that id is already in use'); END;
CREATE TRIGGER questions_insert_new_identity BEFORE INSERT ON questions
WHEN EXISTS (SELECT 1 FROM questions WHERE id = NEW.id OR rowid = NEW.rowid)
BEGIN SELECT RAISE(ABORT, 'ledger rows are never replaced: that id is already in use'); END;
CREATE TRIGGER routings_insert_new_identity BEFORE INSERT ON routings
WHEN EXISTS (SELECT 1 FROM routings WHERE id = NEW.id OR rowid = NEW.rowid)
BEGIN SELECT RAISE(ABORT, 'ledger rows are never replaced: that id is already in use'); END;
CREATE TRIGGER entries_insert_new_identity BEFORE INSERT ON entries
WHEN EXISTS (SELECT 1 FROM entries WHERE id = NEW.id OR rowid = NEW.rowid)
BEGIN SELECT RAISE(ABORT, 'ledger rows are never replaced: that id is already in use'); END;
CREATE TRIGGER provenance_insert_new_seq BEFORE INSERT ON provenance
WHEN EXISTS (SELECT 1 FROM provenance WHERE seq = NEW.seq)
BEGIN SELECT RAISE(ABORT, 'provenance is append-only: that seq is already in use'); END;

-- Physical identity is positive (schema version 2). An AFTER INSERT trigger sees the rowid or
-- seq actually stored, so an explicit rowid/seq of 0 or below is refused whatever the conflict
-- clause, and the -1 an omitted rowid reads as above can never match a stored row.
CREATE TRIGGER workloads_positive_identity AFTER INSERT ON workloads WHEN NEW.rowid <= 0
BEGIN SELECT RAISE(ABORT, 'a ledger rowid is a positive integer'); END;
CREATE TRIGGER slices_positive_identity AFTER INSERT ON slices WHEN NEW.rowid <= 0
BEGIN SELECT RAISE(ABORT, 'a ledger rowid is a positive integer'); END;
CREATE TRIGGER messages_positive_identity AFTER INSERT ON messages WHEN NEW.rowid <= 0
BEGIN SELECT RAISE(ABORT, 'a ledger rowid is a positive integer'); END;
CREATE TRIGGER instructions_positive_identity AFTER INSERT ON instructions WHEN NEW.rowid <= 0
BEGIN SELECT RAISE(ABORT, 'a ledger rowid is a positive integer'); END;
CREATE TRIGGER questions_positive_identity AFTER INSERT ON questions WHEN NEW.rowid <= 0
BEGIN SELECT RAISE(ABORT, 'a ledger rowid is a positive integer'); END;
CREATE TRIGGER routings_positive_identity AFTER INSERT ON routings WHEN NEW.rowid <= 0
BEGIN SELECT RAISE(ABORT, 'a ledger rowid is a positive integer'); END;
CREATE TRIGGER entries_positive_identity AFTER INSERT ON entries WHEN NEW.rowid <= 0
BEGIN SELECT RAISE(ABORT, 'a ledger rowid is a positive integer'); END;
CREATE TRIGGER provenance_positive_seq AFTER INSERT ON provenance WHEN NEW.seq <= 0
BEGIN SELECT RAISE(ABORT, 'a provenance seq is a positive integer'); END;

-- UPDATE OR REPLACE onto another row's rowid would delete that row the same way.
CREATE TRIGGER workloads_keep_rowid BEFORE UPDATE ON workloads WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT, 'a ledger row keeps its rowid'); END;
CREATE TRIGGER slices_keep_rowid BEFORE UPDATE ON slices WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT, 'a ledger row keeps its rowid'); END;
CREATE TRIGGER messages_keep_rowid BEFORE UPDATE ON messages WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT, 'a ledger row keeps its rowid'); END;
CREATE TRIGGER questions_keep_rowid BEFORE UPDATE ON questions WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT, 'a ledger row keeps its rowid'); END;

CREATE TRIGGER workloads_insert_stamp BEFORE INSERT ON workloads
WHEN NEW.rev <> 0 OR NEW.changed_at IS NOT NEW.created_at OR NEW.changed_by IS NOT NEW.created_by
BEGIN SELECT RAISE(ABORT, 'insert must start at rev 0 with changed_by/changed_at equal to created_by/created_at'); END;
CREATE TRIGGER slices_insert_stamp BEFORE INSERT ON slices
WHEN NEW.rev <> 0 OR NEW.changed_at IS NOT NEW.created_at OR NEW.changed_by IS NOT NEW.created_by
BEGIN SELECT RAISE(ABORT, 'insert must start at rev 0 with changed_by/changed_at equal to created_by/created_at'); END;
CREATE TRIGGER messages_insert_stamp BEFORE INSERT ON messages
WHEN NEW.rev <> 0 OR NEW.changed_at IS NOT NEW.created_at OR NEW.changed_by IS NOT NEW.created_by
BEGIN SELECT RAISE(ABORT, 'insert must start at rev 0 with changed_by/changed_at equal to created_by/created_at'); END;
CREATE TRIGGER questions_insert_stamp BEFORE INSERT ON questions
WHEN NEW.rev <> 0 OR NEW.changed_at IS NOT NEW.created_at OR NEW.changed_by IS NOT NEW.created_by
BEGIN SELECT RAISE(ABORT, 'insert must start at rev 0 with changed_by/changed_at equal to created_by/created_at'); END;

CREATE TRIGGER workloads_update_stamp BEFORE UPDATE ON workloads
WHEN NEW.rev IS NOT OLD.rev + 1 OR NEW.changed_at < OLD.changed_at
BEGIN SELECT RAISE(ABORT, 'unstamped update: set changed_by, a changed_at not earlier than the last, and rev = rev + 1'); END;
CREATE TRIGGER slices_update_stamp BEFORE UPDATE ON slices
WHEN NEW.rev IS NOT OLD.rev + 1 OR NEW.changed_at < OLD.changed_at
BEGIN SELECT RAISE(ABORT, 'unstamped update: set changed_by, a changed_at not earlier than the last, and rev = rev + 1'); END;
CREATE TRIGGER messages_update_stamp BEFORE UPDATE ON messages
WHEN NEW.rev IS NOT OLD.rev + 1 OR NEW.changed_at < OLD.changed_at
BEGIN SELECT RAISE(ABORT, 'unstamped update: set changed_by, a changed_at not earlier than the last, and rev = rev + 1'); END;
CREATE TRIGGER questions_update_stamp BEFORE UPDATE ON questions
WHEN NEW.rev IS NOT OLD.rev + 1 OR NEW.changed_at < OLD.changed_at
BEGIN SELECT RAISE(ABORT, 'unstamped update: set changed_by, a changed_at not earlier than the last, and rev = rev + 1'); END;

CREATE TRIGGER workloads_immutable BEFORE UPDATE OF id, brief, created_by, created_at ON workloads
WHEN NEW.id IS NOT OLD.id OR NEW.brief IS NOT OLD.brief OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'id, brief and creation provenance of a workload never change'); END;
CREATE TRIGGER slices_immutable BEFORE UPDATE OF id, workload_id, task, done_condition, inputs, created_by, created_at ON slices
WHEN NEW.id IS NOT OLD.id OR NEW.workload_id IS NOT OLD.workload_id OR NEW.task IS NOT OLD.task
  OR NEW.done_condition IS NOT OLD.done_condition OR NEW.inputs IS NOT OLD.inputs
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'id, workload, brief fields and creation provenance of a slice never change'); END;
CREATE TRIGGER messages_immutable BEFORE UPDATE OF id, workload_id, slice_id, sender, recipient, body, created_by, created_at ON messages
WHEN NEW.id IS NOT OLD.id OR NEW.workload_id IS NOT OLD.workload_id OR NEW.slice_id IS NOT OLD.slice_id
  OR NEW.sender IS NOT OLD.sender OR NEW.recipient IS NOT OLD.recipient OR NEW.body IS NOT OLD.body
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'only state and its stamp change on a message'); END;
CREATE TRIGGER questions_immutable BEFORE UPDATE OF id, workload_id, slice_id, body, options, created_by, created_at ON questions
WHEN NEW.id IS NOT OLD.id OR NEW.workload_id IS NOT OLD.workload_id OR NEW.slice_id IS NOT OLD.slice_id
  OR NEW.body IS NOT OLD.body OR NEW.options IS NOT OLD.options
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'a question keeps its id, slice, text and options for life'); END;

CREATE TRIGGER instructions_no_update BEFORE UPDATE ON instructions
BEGIN SELECT RAISE(ABORT, 'instructions are append-only'); END;
CREATE TRIGGER routings_no_update BEFORE UPDATE ON routings
BEGIN SELECT RAISE(ABORT, 'routings are append-only'); END;
CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries
BEGIN SELECT RAISE(ABORT, 'entries are append-only'); END;
CREATE TRIGGER provenance_no_update BEFORE UPDATE ON provenance
BEGIN SELECT RAISE(ABORT, 'provenance is append-only'); END;

CREATE TRIGGER workloads_no_delete BEFORE DELETE ON workloads
BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER slices_no_delete BEFORE DELETE ON slices
BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER instructions_no_delete BEFORE DELETE ON instructions
BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER questions_no_delete BEFORE DELETE ON questions
BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER routings_no_delete BEFORE DELETE ON routings
BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries
BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER provenance_no_delete BEFORE DELETE ON provenance
BEGIN SELECT RAISE(ABORT, 'provenance is append-only'); END;

-- Existence and agreement, enforced whether or not the connection turned foreign_keys on.
-- A child row needs an OPEN workload; a named slice or question must belong to that workload.
CREATE TRIGGER slices_insert_workload BEFORE INSERT ON slices
WHEN NOT EXISTS (SELECT 1 FROM workloads WHERE id = NEW.workload_id AND status = 'open')
BEGIN SELECT RAISE(ABORT, 'no open workload with that id'); END;
CREATE TRIGGER messages_insert_workload BEFORE INSERT ON messages
WHEN NOT EXISTS (SELECT 1 FROM workloads WHERE id = NEW.workload_id AND status = 'open')
  OR (NEW.slice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM slices WHERE id = NEW.slice_id AND workload_id = NEW.workload_id))
BEGIN SELECT RAISE(ABORT, 'no open workload with that id, or the slice belongs to another workload'); END;
CREATE TRIGGER instructions_insert_workload BEFORE INSERT ON instructions
WHEN NOT EXISTS (SELECT 1 FROM workloads WHERE id = NEW.workload_id AND status = 'open')
  OR (NEW.slice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM slices WHERE id = NEW.slice_id AND workload_id = NEW.workload_id))
BEGIN SELECT RAISE(ABORT, 'no open workload with that id, or the slice belongs to another workload'); END;
CREATE TRIGGER questions_insert_workload BEFORE INSERT ON questions
WHEN NOT EXISTS (SELECT 1 FROM workloads WHERE id = NEW.workload_id AND status = 'open')
  OR NOT EXISTS (SELECT 1 FROM slices WHERE id = NEW.slice_id AND workload_id = NEW.workload_id AND state IN ('open', 'paused'))
BEGIN SELECT RAISE(ABORT, 'a question needs an open workload and a running or paused slice of that workload'); END;
CREATE TRIGGER routings_insert_workload BEFORE INSERT ON routings
WHEN NOT EXISTS (SELECT 1 FROM workloads WHERE id = NEW.workload_id AND status = 'open')
  OR NOT EXISTS (SELECT 1 FROM slices WHERE id = NEW.slice_id AND workload_id = NEW.workload_id)
BEGIN SELECT RAISE(ABORT, 'no open workload with that id, or the slice belongs to another workload'); END;
CREATE TRIGGER entries_insert_workload BEFORE INSERT ON entries
WHEN NOT EXISTS (SELECT 1 FROM workloads WHERE id = NEW.workload_id AND status = 'open')
  OR (NEW.slice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM slices WHERE id = NEW.slice_id AND workload_id = NEW.workload_id))
BEGIN SELECT RAISE(ABORT, 'no open workload with that id, or the slice belongs to another workload'); END;
CREATE TRIGGER provenance_insert_workload BEFORE INSERT ON provenance
WHEN NOT EXISTS (SELECT 1 FROM workloads WHERE id = NEW.workload_id)
BEGIN SELECT RAISE(ABORT, 'provenance must name an existing workload'); END;

-- =============================================================================================
-- State order.
-- =============================================================================================

-- Workloads: born open with no holder; open -> closed once; closed is final.
CREATE TRIGGER workloads_insert_open BEFORE INSERT ON workloads
WHEN NEW.status IS NOT 'open' OR NEW.holder IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a workload is opened in status open with no holder'); END;

CREATE TRIGGER workloads_status_order BEFORE UPDATE OF status ON workloads
WHEN NEW.status IS NOT OLD.status AND NOT (OLD.status = 'open' AND NEW.status = 'closed')
BEGIN SELECT RAISE(ABORT, 'illegal workload transition: a closed workload stays closed'); END;

CREATE TRIGGER workloads_close_clean BEFORE UPDATE OF status ON workloads
WHEN NEW.status = 'closed' AND OLD.status = 'open' AND (
     EXISTS (SELECT 1 FROM slices WHERE workload_id = OLD.id AND state IN ('open', 'paused'))
  OR EXISTS (SELECT 1 FROM questions WHERE workload_id = OLD.id AND state = 'open'))
BEGIN SELECT RAISE(ABORT, 'cannot close a workload with open or paused slices or open questions'); END;

-- Lease + reclaim: a held workload moves to another holder only after release (holder NULL) or
-- once the current lease has expired by the database clock. A NULL lease never expires (Jo).
CREATE TRIGGER workloads_holder_no_steal BEFORE UPDATE OF holder ON workloads
WHEN OLD.holder IS NOT NULL AND NEW.holder IS NOT NULL AND NEW.holder IS NOT OLD.holder
 AND (OLD.holder_lease_until IS NULL OR OLD.holder_lease_until >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workload is held under a live lease; release it or wait for the lease to expire'); END;

-- A mode flip is a ledgered instruction (§ B13.1): record the instruction first, then flip.
CREATE TRIGGER workloads_mode_needs_instruction BEFORE UPDATE OF mode ON workloads
WHEN NEW.mode IS NOT OLD.mode AND NOT EXISTS (
  SELECT 1 FROM instructions WHERE workload_id = OLD.id AND kind = 'mode-flip'
    AND body = NEW.mode AND created_at >= OLD.changed_at)
BEGIN SELECT RAISE(ABORT, 'a mode flip needs a mode-flip instruction recorded since the last workload change'); END;

-- A stakes change is a ledgered instruction too (schema version 6, ledger audit A2-3): the surface
-- records `stakes: <stakes>` and changes the stakes in one transaction (surface/src/input.ts); the
-- file now refuses a change with no such instruction, as it does a mode flip.
CREATE TRIGGER workloads_stakes_needs_instruction BEFORE UPDATE OF stakes ON workloads
WHEN NEW.stakes IS NOT OLD.stakes AND NOT EXISTS (
  SELECT 1 FROM instructions WHERE workload_id = OLD.id AND kind = 'instruction'
    AND body = 'stakes: ' || NEW.stakes AND created_at >= OLD.changed_at)
BEGIN SELECT RAISE(ABORT, 'a stakes change needs a "stakes: <stakes>" instruction recorded since the last workload change'); END;

-- The standing orchestrator workload is never closed (schema version 6, ledger audit A2-4): every
-- wake writes to it, and a closed workload takes no entries.
CREATE TRIGGER workloads_standing_never_closes BEFORE UPDATE OF status ON workloads
WHEN OLD.id = 'wl-orchestrator' AND OLD.status = 'open' AND NEW.status = 'closed'
BEGIN SELECT RAISE(ABORT, 'the standing workload wl-orchestrator is never closed'); END;

-- Final states are final (schema version 6, ledger audit A3-1): a closed workload, a done or
-- cancelled slice and an acted-on message take no UPDATE at all. A change of state out of a final
-- state is already refused by the state-order trigger of its table; these refuse every update that
-- keeps the state, which the state-order triggers let through: a second completion rewriting a done
-- slice's artifact, a re-advance of an acted-on message, stakes set on a closed workload. Between the
-- two, exactly one trigger refuses each update of a final row.
CREATE TRIGGER workloads_closed_final BEFORE UPDATE ON workloads
WHEN OLD.status = 'closed' AND NEW.status IS OLD.status
BEGIN SELECT RAISE(ABORT, 'a closed workload is final: nothing on it changes'); END;
CREATE TRIGGER slices_final BEFORE UPDATE ON slices
WHEN OLD.state IN ('done', 'cancelled') AND NEW.state IS OLD.state
BEGIN SELECT RAISE(ABORT, 'a done or cancelled slice is final: nothing on it changes, its artifact included'); END;
CREATE TRIGGER messages_acted_on_final BEFORE UPDATE ON messages
WHEN OLD.state = 'acted-on' AND NEW.state IS OLD.state
BEGIN SELECT RAISE(ABORT, 'an acted-on message is final: nothing on it changes'); END;

-- Slices: born open. open <-> paused (paused only while a question on the slice is open);
-- open -> done (with an artifact); open|paused -> cancelled (no open question). done and
-- cancelled are final.
CREATE TRIGGER slices_insert_open BEFORE INSERT ON slices
WHEN NEW.state IS NOT 'open'
BEGIN SELECT RAISE(ABORT, 'a slice is created in state open'); END;

CREATE TRIGGER slices_state_order BEFORE UPDATE OF state ON slices
WHEN NEW.state IS NOT OLD.state AND NOT (
     (OLD.state = 'open'   AND NEW.state IN ('paused', 'done', 'cancelled'))
  OR (OLD.state = 'paused' AND NEW.state IN ('open', 'cancelled')))
BEGIN SELECT RAISE(ABORT, 'illegal slice transition'); END;

CREATE TRIGGER slices_pause_needs_question BEFORE UPDATE OF state ON slices
WHEN NEW.state = 'paused' AND OLD.state = 'open'
 AND NOT EXISTS (SELECT 1 FROM questions WHERE slice_id = OLD.id AND state = 'open')
BEGIN SELECT RAISE(ABORT, 'a slice pauses only on an open question'); END;

CREATE TRIGGER slices_leave_pause_needs_resolution BEFORE UPDATE OF state ON slices
WHEN OLD.state = 'paused' AND NEW.state IN ('open', 'cancelled')
 AND EXISTS (SELECT 1 FROM questions WHERE slice_id = OLD.id AND state = 'open')
BEGIN SELECT RAISE(ABORT, 'slice has an open question; answer or withdraw it first'); END;

-- Messages: born held; held -> delivered -> consumed -> acted-on, one step, never back.
CREATE TRIGGER messages_insert_held BEFORE INSERT ON messages
WHEN NEW.state IS NOT 'held'
BEGIN SELECT RAISE(ABORT, 'message must be enqueued in state held'); END;

CREATE TRIGGER messages_state_order BEFORE UPDATE OF state ON messages
WHEN NEW.state IS NOT OLD.state AND NOT (
     (OLD.state = 'held'      AND NEW.state = 'delivered')
  OR (OLD.state = 'delivered' AND NEW.state = 'consumed')
  OR (OLD.state = 'consumed'  AND NEW.state = 'acted-on'))
BEGIN SELECT RAISE(ABORT, 'illegal message transition'); END;

-- Questions: born open; open -> answered | withdrawn, only by an instruction of the matching
-- kind that names this question. Resolved is final.
CREATE TRIGGER questions_insert_open BEFORE INSERT ON questions
WHEN NEW.state IS NOT 'open' OR NEW.resolved_by IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a question is raised in state open'); END;

CREATE TRIGGER questions_state_order BEFORE UPDATE OF state, resolved_by ON questions
WHEN (NEW.state IS NOT OLD.state OR NEW.resolved_by IS NOT OLD.resolved_by)
 AND NOT (OLD.state = 'open' AND NEW.state IN ('answered', 'withdrawn'))
BEGIN SELECT RAISE(ABORT, 'illegal question transition: a resolved question stays resolved'); END;

CREATE TRIGGER questions_resolution_needs_instruction BEFORE UPDATE OF state ON questions
WHEN OLD.state = 'open' AND NEW.state IN ('answered', 'withdrawn') AND NOT EXISTS (
  SELECT 1 FROM instructions WHERE id = NEW.resolved_by AND question_id = OLD.id
    AND kind = CASE NEW.state WHEN 'answered' THEN 'answer' ELSE 'withdrawal' END)
BEGIN SELECT RAISE(ABORT, 'a question is resolved only by an answer or withdrawal instruction naming it'); END;

-- Instructions that answer or withdraw must name an open question of the same workload.
CREATE TRIGGER instructions_question_open BEFORE INSERT ON instructions
WHEN NEW.question_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM questions WHERE id = NEW.question_id AND workload_id = NEW.workload_id AND state = 'open')
BEGIN SELECT RAISE(ABORT, 'answer or withdrawal must name an open question of this workload'); END;

-- Options are strings. CHECK constraints cannot use json_each, so the element type is a trigger;
-- the column CHECK keeps "valid JSON array of at least two".
CREATE TRIGGER questions_options_strings BEFORE INSERT ON questions
WHEN json_valid(NEW.options) AND json_type(NEW.options) = 'array'
 AND EXISTS (SELECT 1 FROM json_each(NEW.options) WHERE type IS NOT 'text')
BEGIN SELECT RAISE(ABORT, 'question options must be a JSON array of strings'); END;

-- A routing's model lists name models: every entry of `models` and of `ran_models` is a non-blank
-- string ("blank" as defined above the routings table: tab-, newline- and other whitespace-only
-- names are blank, astra review 4 N1), and `ran_models` names each model once (astra review 3, S1).
-- The column CHECKs keep shape, count and the outcome agreement; element rules need json_each, so
-- they are a trigger.
CREATE TRIGGER routings_model_lists BEFORE INSERT ON routings
WHEN (json_valid(NEW.models) AND json_type(NEW.models) = 'array'
      AND EXISTS (SELECT 1 FROM json_each(NEW.models) WHERE type IS NOT 'text'
                  OR length(trim(value, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) = 0))
  OR (NEW.ran_models IS NOT NULL AND json_valid(NEW.ran_models) AND json_type(NEW.ran_models) = 'array'
      AND (EXISTS (SELECT 1 FROM json_each(NEW.ran_models) WHERE type IS NOT 'text'
                   OR length(trim(value, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) = 0)
           OR (SELECT count(*) FROM json_each(NEW.ran_models)) <> (SELECT count(DISTINCT value) FROM json_each(NEW.ran_models))))
BEGIN SELECT RAISE(ABORT, 'routing models and ran_models must be JSON arrays of distinct non-blank model names'); END;

-- One hand, one row: a session root never allocates one agent id twice (OMP's output manager seeds
-- its taken ids from the root's files on resume), so a second row for the same root and agent id
-- could only make durable recovery ambiguous. A trigger, not a UNIQUE index: a UNIQUE conflict under
-- INSERT OR REPLACE would delete the first row without firing the delete triggers.
CREATE TRIGGER routings_one_row_per_hand BEFORE INSERT ON routings
WHEN NEW.agent_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM routings WHERE session_root = NEW.session_root AND agent_id = NEW.agent_id)
BEGIN SELECT RAISE(ABORT, 'a hand has one routing row: that session root already has a row for that agent id'); END;

-- Raising a question pauses its slice (only that slice).
CREATE TRIGGER questions_pause_slice AFTER INSERT ON questions
WHEN (SELECT state FROM slices WHERE id = NEW.slice_id) = 'open'
BEGIN
  UPDATE slices SET state = 'paused', changed_by = NEW.created_by,
    changed_at = max(changed_at, NEW.created_at), rev = rev + 1
  WHERE id = NEW.slice_id;
END;

-- Resolving the last open question on a paused slice settles the slice in the same statement:
-- cancelled if any withdrawal of a question on this slice carried disposition 'cancel',
-- otherwise open again (an answer, or a 'replan' withdrawal). A cancel given while another
-- question was still open is therefore deferred, never lost: answering the other question later
-- cancels the slice. Every question on a slice that is still paused belongs to its current pause
-- (a slice leaves pause only through this trigger, and a cancel disposition makes it final), so
-- no older withdrawal can leak in.
CREATE TRIGGER questions_resolution_settles_slice AFTER UPDATE OF state ON questions
WHEN OLD.state = 'open' AND NEW.state IN ('answered', 'withdrawn')
 AND (SELECT state FROM slices WHERE id = NEW.slice_id) = 'paused'
 AND NOT EXISTS (SELECT 1 FROM questions WHERE slice_id = NEW.slice_id AND state = 'open')
BEGIN
  UPDATE slices SET
    state = CASE WHEN EXISTS (
      SELECT 1 FROM questions q JOIN instructions i ON i.id = q.resolved_by
       WHERE q.slice_id = NEW.slice_id AND q.state = 'withdrawn' AND i.disposition = 'cancel')
      THEN 'cancelled' ELSE 'open' END,
    changed_by = NEW.changed_by, changed_at = max(changed_at, NEW.changed_at), rev = rev + 1
  WHERE id = NEW.slice_id;
END;

-- =============================================================================================
-- Provenance: every insert and update appends (workload, lane instance, time).
-- =============================================================================================
CREATE TRIGGER workloads_log_insert AFTER INSERT ON workloads BEGIN
  INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail)
  VALUES (NEW.created_at, NEW.id, NEW.created_by, 'workloads', NEW.id, 'insert',
          'open stakes=' || NEW.stakes || ' mode=' || NEW.mode);
END;
CREATE TRIGGER workloads_log_update AFTER UPDATE ON workloads BEGIN
  INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail)
  VALUES (NEW.changed_at, NEW.id, NEW.changed_by, 'workloads', NEW.id, 'update',
          trim(
            CASE WHEN NEW.status IS NOT OLD.status THEN 'status ' || OLD.status || '->' || NEW.status || ' ' ELSE '' END ||
            CASE WHEN NEW.holder IS NOT OLD.holder THEN 'holder ' || coalesce(OLD.holder, '-') || '->' || coalesce(NEW.holder, '-') || ' ' ELSE '' END ||
            CASE WHEN NEW.holder_lease_until IS NOT OLD.holder_lease_until THEN 'lease ' || coalesce(NEW.holder_lease_until, '-') || ' ' ELSE '' END ||
            CASE WHEN NEW.stakes IS NOT OLD.stakes THEN 'stakes ' || OLD.stakes || '->' || NEW.stakes || ' ' ELSE '' END ||
            CASE WHEN NEW.mode IS NOT OLD.mode THEN 'mode ' || OLD.mode || '->' || NEW.mode ELSE '' END));
END;
CREATE TRIGGER slices_log_insert AFTER INSERT ON slices BEGIN
  INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail)
  VALUES (NEW.created_at, NEW.workload_id, NEW.created_by, 'slices', NEW.id, 'insert', NEW.state);
END;
CREATE TRIGGER slices_log_update AFTER UPDATE ON slices BEGIN
  INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail)
  VALUES (NEW.changed_at, NEW.workload_id, NEW.changed_by, 'slices', NEW.id, 'update', OLD.state || '->' || NEW.state);
END;
CREATE TRIGGER messages_log_insert AFTER INSERT ON messages BEGIN
  INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail)
  VALUES (NEW.created_at, NEW.workload_id, NEW.created_by, 'messages', NEW.id, 'insert', NEW.state);
END;
CREATE TRIGGER messages_log_update AFTER UPDATE ON messages BEGIN
  INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail)
  VALUES (NEW.changed_at, NEW.workload_id, NEW.changed_by, 'messages', NEW.id, 'update', OLD.state || '->' || NEW.state);
END;
CREATE TRIGGER instructions_log_insert AFTER INSERT ON instructions BEGIN
  INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail)
  VALUES (NEW.created_at, NEW.workload_id, NEW.created_by, 'instructions', NEW.id, 'insert',
          NEW.kind || coalesce(' ' || NEW.question_id, '') || coalesce(' then ' || NEW.disposition, ''));
END;
CREATE TRIGGER questions_log_insert AFTER INSERT ON questions BEGIN
  INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail)
  VALUES (NEW.created_at, NEW.workload_id, NEW.created_by, 'questions', NEW.id, 'insert', 'open slice=' || NEW.slice_id);
END;
CREATE TRIGGER questions_log_update AFTER UPDATE ON questions BEGIN
  INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail)
  VALUES (NEW.changed_at, NEW.workload_id, NEW.changed_by, 'questions', NEW.id, 'update',
          OLD.state || '->' || NEW.state || coalesce(' by ' || NEW.resolved_by, ''));
END;
CREATE TRIGGER routings_log_insert AFTER INSERT ON routings BEGIN
  INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail)
  VALUES (NEW.created_at, NEW.workload_id, NEW.created_by, 'routings', NEW.id, 'insert',
          NEW.kind || ' ' || NEW.classified_tier || coalesce(' up ' || NEW.pull_up_to, '')
          || coalesce(' down ' || NEW.pull_down_to, '') || ' -> ' || NEW.tier || ' ' || coalesce(NEW.model, '(no usable model)')
          || ': ' || NEW.outcome
          || coalesce(' on ' || (SELECT group_concat(value, ', ') FROM json_each(NEW.ran_models)), ''));
END;
CREATE TRIGGER entries_log_insert AFTER INSERT ON entries BEGIN
  INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail)
  VALUES (NEW.created_at, NEW.workload_id, NEW.created_by, 'entries', NEW.id, 'insert', NEW.kind);
END;

-- =============================================================================================
-- Read-side view: a workload with its derived last activity (latest provenance row). Derived,
-- so it cannot drift from what was written.
-- =============================================================================================
CREATE VIEW workload_status AS
SELECT w.*,
  (SELECT max(p.at) FROM provenance p WHERE p.workload_id = w.id) AS last_activity_at,
  (SELECT count(*) FROM slices s WHERE s.workload_id = w.id AND s.state = 'open') AS open_slices,
  (SELECT count(*) FROM slices s WHERE s.workload_id = w.id AND s.state = 'paused') AS paused_slices,
  (SELECT count(*) FROM questions q WHERE q.workload_id = w.id AND q.state = 'open') AS open_questions,
  (SELECT count(*) FROM messages m WHERE m.workload_id = w.id AND m.state = 'held') AS held_messages,
  (SELECT min(m.created_at) FROM messages m WHERE m.workload_id = w.id AND m.state = 'held') AS oldest_held_at
FROM workloads w;

PRAGMA user_version = 6;

COMMIT;
