Inspect or maintain every durable record created by one retain request.

Use `list` to find recent request groups. Use `invalidate` when the group should
stop participating in recall while preserving history, and `restore` when it is
valid again. Permanent purge is intentionally unavailable to the model and must
be initiated by the user through `/knowledge purge-group <id> --confirm`.
