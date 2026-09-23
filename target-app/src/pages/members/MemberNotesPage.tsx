import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NotebookPen, Pin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "../../components/Button";
import { Badge, Panel } from "../../components/display";
import { Banner, EmptyState, LoadError, SkeletonLines, SlowNotice } from "../../components/feedback";
import { Check, Field, Select, Textarea } from "../../components/form";
import { Pager } from "../../components/navigation";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { isApiError, type FieldError } from "../../lib/errors";
import { dateTime } from "../../lib/format";
import type { Note, NoteCategory } from "../../lib/types";
import { keys, useMemberDetail } from "../queries";

const CATEGORIES: NoteCategory[] = ["Service", "Account maintenance", "Fraud", "Collections", "Complaint", "Compliance"];
const CATEGORY_TONE: Record<NoteCategory, "info" | "neutral" | "bad" | "warn"> = {
  Service: "info",
  "Account maintenance": "neutral",
  Fraud: "bad",
  Collections: "warn",
  Complaint: "warn",
  Compliance: "neutral",
};
const PAGE = 20;

export function NoteItem({ note }: { note: Note }) {
  return (
    <article className={`note${note.is_pinned ? " note--pinned" : ""}`}>
      <div className="note__head">
        <Badge tone={CATEGORY_TONE[note.category]}>{note.category}</Badge>
        {note.is_pinned && (
          <Badge tone="warn">
            <Pin aria-hidden="true" /> Pinned
          </Badge>
        )}
        <span className="note__author">{note.author_name}</span>
        <span>· {dateTime(note.created_at)}</span>
      </div>
      <p className="note__body">{note.body}</p>
    </article>
  );
}

export function MemberNotesPage() {
  const detail = useMemberDetail();
  const n = detail.member.member_number;
  const [params, setParams] = useSearchParams();
  const composing = params.get("compose") === "1";
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: keys.notes(n, offset),
    queryFn: () => api.notes(n, PAGE, offset),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="page">
      <div className="grid-12">
        <div className={composing ? "span-8" : "span-12"}>
          <div className="stack">
            <SlowNotice active={q.isFetching} what="notes" />
            <Panel
              title="Notes"
              icon={<NotebookPen size={15} aria-hidden="true" />}
              count={q.data ? `· ${q.data.total}` : undefined}
              flush
              actions={
                detail.capabilities.add_notes &&
                !composing && (
                  <Button size="sm" variant="primary" icon={<NotebookPen size={13} aria-hidden="true" />} onClick={() => setParams({ compose: "1" })}>
                    Add note
                  </Button>
                )
              }
              footer={q.data && q.data.total > PAGE ? <Pager total={q.data.total} limit={PAGE} offset={offset} onChange={setOffset} noun="notes" /> : undefined}
            >
              {q.isPending ? (
                <div className="panel__body">
                  <SkeletonLines lines={8} />
                </div>
              ) : q.isError ? (
                <div className="panel__body">
                  <LoadError error={q.error} onRetry={() => q.refetch()} what="notes" />
                </div>
              ) : q.data.rows.length === 0 ? (
                <EmptyState title="No notes on this membership">Record calls, visits, and requests so the next person has the context.</EmptyState>
              ) : (
                q.data.rows.map((note) => <NoteItem key={note.id} note={note} />)
              )}
            </Panel>
          </div>
        </div>
        {composing && (
          <div className="span-4">
            <ComposeNote memberNumber={n} onDone={() => setParams({})} />
          </div>
        )}
      </div>
    </div>
  );
}

function ComposeNote({ memberNumber, onDone }: { memberNumber: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [category, setCategory] = useState<NoteCategory | "">("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  const save = useMutation({
    mutationFn: () => api.addNote(memberNumber, category, body, pinned),
    onSuccess: () => {
      toast.show({ title: "Note added", text: `Saved to member ${memberNumber}.` });
      void qc.invalidateQueries({ queryKey: ["member-notes", memberNumber] });
      void qc.invalidateQueries({ queryKey: keys.member(memberNumber) });
      onDone();
    },
    onError: (e) => {
      if (isApiError(e) && e.kind === "validation") setErrors(e.fields);
    },
  });

  const errorFor = (f: string) => errors.find((e) => e.field === f)?.message;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const local: FieldError[] = [];
    if (!category) local.push({ field: "category", message: "Choose a category." });
    if (body.trim().length < 5) local.push({ field: "body", message: "Write at least 5 characters." });
    setErrors(local);
    if (!local.length) save.mutate();
  };

  const serverError = save.isError && !(isApiError(save.error) && save.error.kind === "validation") ? save.error : null;

  return (
    <Panel title="Add note">
      <form className="stack stack--sm" onSubmit={submit} noValidate>
        {serverError && <LoadError error={serverError} what="the note" />}
        {errors.length > 0 && !serverError && (
          <Banner tone="bad" live>
            Fix the highlighted fields to save the note.
          </Banner>
        )}
        <Field label="Category" error={errorFor("category")}>
          <Select value={category} onChange={(e) => setCategory(e.target.value as NoteCategory)}>
            <option value="">Choose…</option>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="Note" error={errorFor("body")} hint={`${body.length.toLocaleString()} / 2,000 characters`}>
          <Textarea ref={bodyRef} rows={7} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What happened, what you did, and any follow-up." />
        </Field>
        <Check label="Pin to the top of this member's notes" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        <div className="toolbar">
          <span className="toolbar__spacer" />
          <Button onClick={onDone} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} loadingText="Saving…">
            Save note
          </Button>
        </div>
      </form>
    </Panel>
  );
}
