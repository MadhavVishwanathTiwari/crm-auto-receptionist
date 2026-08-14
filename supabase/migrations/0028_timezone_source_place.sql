-- Adds 'place' to timezone_source: a zone derived from location text rather
-- than from coordinates.
--
-- Its own file, and nothing uses the value here, because ALTER TYPE ... ADD
-- VALUE cannot be used by a later statement in the same transaction. 0029
-- teaches the guard trigger about it.

alter type timezone_source add value if not exists 'place';
