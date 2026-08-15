"use client";

import {
  useId,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

type AttentionNote = Readonly<{ body: string; tone: string }>;
type Offset = Readonly<{ x: number; y: number }>;
type ActiveDrag = Readonly<{
  index: number;
  pointerId: number;
  pointerX: number;
  pointerY: number;
  origin: Offset;
}>;

const restingOffset: Offset = { x: 0, y: 0 };

export function AttentionNotes({
  label,
  hint,
  notes,
}: {
  label: ReactNode;
  hint: ReactNode;
  notes: ReadonlyArray<AttentionNote>;
}) {
  const instructionId = useId();
  const hintId = `${instructionId}-hint`;
  const keyboardInstructionId = `${instructionId}-keyboard`;
  const [offsets, setOffsets] = useState<ReadonlyArray<Offset>>(() =>
    notes.map(() => restingOffset),
  );
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  const moved = offsets.some(({ x, y }) => x !== 0 || y !== 0);

  function updateOffset(index: number, offset: Offset) {
    setOffsets((current) => current.map((item, itemIndex) =>
      itemIndex === index ? offset : item,
    ));
  }

  function beginDrag(index: number, event: PointerEvent<HTMLLIElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      index,
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      origin: offsets[index] ?? restingOffset,
    });
  }

  function continueDrag(event: PointerEvent<HTMLLIElement>) {
    if (drag === null || drag.pointerId !== event.pointerId) return;
    updateOffset(drag.index, {
      x: drag.origin.x + event.clientX - drag.pointerX,
      y: drag.origin.y + event.clientY - drag.pointerY,
    });
  }

  function endDrag(event: PointerEvent<HTMLLIElement>) {
    if (drag?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  }

  function nudge(index: number, event: KeyboardEvent<HTMLLIElement>) {
    const movement = {
      ArrowLeft: { x: -8, y: 0 },
      ArrowRight: { x: 8, y: 0 },
      ArrowUp: { x: 0, y: -8 },
      ArrowDown: { x: 0, y: 8 },
    }[event.key];
    if (movement === undefined) return;
    event.preventDefault();
    const current = offsets[index] ?? restingOffset;
    updateOffset(index, {
      x: current.x + movement.x,
      y: current.y + movement.y,
    });
  }

  return (
    <div className="lh-attention">
      <div className="lh-attention-heading">
        <h3>{label}</h3>
        <div className="lh-attention-guidance">
          <p id={hintId}>{hint}</p>
          <p id={keyboardInstructionId}>
            Drag with a pointer, or focus a note and use the arrow keys.
          </p>
        </div>
        {moved ? (
          <button type="button" onClick={() => setOffsets(notes.map(() => restingOffset))}>
            put them back
          </button>
        ) : null}
      </div>
      <ul>
        {notes.map((note, index) => {
          const offset = offsets[index] ?? restingOffset;
          return (
            <li
              key={`${note.body}-${index}`}
              data-dragging={drag?.index === index ? "true" : "false"}
              data-tone={note.tone}
              aria-describedby={`${hintId} ${keyboardInstructionId}`}
              onKeyDown={(event) => nudge(index, event)}
              onPointerCancel={endDrag}
              onPointerDown={(event) => beginDrag(index, event)}
              onPointerMove={continueDrag}
              onPointerUp={endDrag}
              style={{
                "--lh-note-x": `${offset.x}px`,
                "--lh-note-y": `${offset.y}px`,
              } as CSSProperties}
              tabIndex={0}
            >
              {note.body}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
