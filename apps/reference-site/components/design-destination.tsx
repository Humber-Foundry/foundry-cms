"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  designAccentPalette,
  designEditsForDesign,
  designFontStack,
  designNeutralPalette,
  designPresets,
  matchDesignPreset,
  type DesignOptionPreview,
  type SiteDefinition,
  type SiteDefinitionEdit,
} from "@humber-foundry/site-definition";

import {
  designControlGroups,
  optionColumns,
  type DesignControl,
  type DesignControlOption,
} from "@/src/design-destination-controls";
import { SiteRenderer } from "./site-renderer";

/**
 * The Design destination.
 *
 * The left column chooses; the right column shows the real site with the
 * choice already made. Both read the same working draft, so nothing on screen
 * can describe a design the site is not using. Saving, previewing and
 * publishing stay with the toolbar above, which is the same draft workflow
 * Pages uses.
 */

/**
 * The width the preview lays the site out at before it is scaled to fit. It is
 * wider than the widest content-width option, so every width option has room
 * to show a different result. The widest option is 92rem, or 1472px.
 */
const previewLayoutWidth = 1560;

/** An id from a group title, which may contain spaces an HTML id may not. */
function groupHeadingId(prefix: string, title: string): string {
  return `${prefix}-${title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}`;
}

/**
 * The paper, ink, accent and heading font one preset actually paints with, so
 * the card is a small sample of the look it applies. Every value is read from
 * the design contract, which is the only place they are written down.
 */
function presetSwatchStyle(design: SiteDefinition["design"]): CSSProperties {
  const neutral = designNeutralPalette(design.colour.neutral);
  return {
    "--swatch-paper": neutral.paper,
    "--swatch-panel": neutral.panel,
    "--swatch-ink": neutral.ink,
    "--swatch-accent": designAccentPalette(design.colour.accent).colour,
    "--swatch-heading-font": designFontStack(
      "typography.heading",
      design.typography.heading,
    ),
  } as CSSProperties;
}

function OptionSample({ preview }: { preview: DesignOptionPreview }) {
  if (preview.kind === "font") {
    return (
      <span
        className="design-sample design-sample-font"
        style={{ fontFamily: preview.fontFamily }}
        aria-hidden="true"
      >
        Ag
      </span>
    );
  }
  if (preview.kind === "accent") {
    return (
      <span
        className="design-sample design-sample-accent"
        style={
          {
            "--sample-colour": preview.colour,
            "--sample-deep-colour": preview.deepColour,
          } as CSSProperties
        }
        aria-hidden="true"
      />
    );
  }
  if (preview.kind === "neutral") {
    return (
      <span
        className="design-sample design-sample-neutral"
        style={
          {
            "--sample-paper": preview.paper,
            "--sample-panel": preview.panel,
            "--sample-ink": preview.ink,
          } as CSSProperties
        }
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      className="design-sample design-sample-scale"
      style={{ "--sample-ratio": preview.ratio } as CSSProperties}
      aria-hidden="true"
    />
  );
}

function DesignOptionCard({
  control,
  option,
  disabled,
  onChoose,
}: {
  control: DesignControl;
  option: DesignControlOption;
  disabled: boolean;
  onChoose(value: string): void;
}) {
  const selected = control.value === option.value;
  return (
    <label className="design-option" data-selected={selected}>
      <input
        type="radio"
        name={control.path}
        value={option.value}
        checked={selected}
        disabled={disabled}
        onChange={() => onChoose(option.value)}
      />
      {option.preview === undefined ? null : (
        <OptionSample preview={option.preview} />
      )}
      <span className="design-option-label">{option.label}</span>
      <span className="design-option-description">{option.description}</span>
    </label>
  );
}

export function DesignDestination({
  definition,
  disabled = false,
  onEdit,
  onEditMany,
}: {
  /** The working draft. Everything on screen is read from this one value. */
  definition: SiteDefinition;
  disabled?: boolean;
  onEdit(edit: SiteDefinitionEdit): void;
  onEditMany(edits: ReadonlyArray<SiteDefinitionEdit>): void;
}) {
  const groups = useMemo(
    () => designControlGroups(definition),
    [definition],
  );
  const selectedPreset = useMemo(
    () => matchDesignPreset(definition.design),
    [definition.design],
  );
  const presetHeadingId = useId();
  const groupHeadingPrefix = useId();
  const previewScale = usePreviewScale();

  return (
    <div className="design-destination">
      <div className="design-controls">
        <section
          className="design-section"
          aria-labelledby={presetHeadingId}
        >
          <h2 id={presetHeadingId}>Start from a look</h2>
          <p className="design-section-help">
            {selectedPreset === undefined
              ? "Your site does not match any of these looks. Choose one to replace every setting below, or keep fine-tuning."
              : `Your site uses the ${selectedPreset.name} look. Choosing another replaces every setting below.`}
          </p>
          <fieldset
            className="design-presets"
            aria-labelledby={presetHeadingId}
            style={
              {
                "--option-columns": optionColumns(designPresets.length),
              } as CSSProperties
            }
          >
            {designPresets.map((preset) => (
              <label
                key={preset.id}
                className="design-preset"
                data-selected={selectedPreset?.id === preset.id}
              >
                <input
                  type="radio"
                  name="design-preset"
                  value={preset.id}
                  checked={selectedPreset?.id === preset.id}
                  disabled={disabled}
                  onChange={() =>
                    onEditMany(
                      designEditsForDesign(definition.design, preset.design),
                    )
                  }
                />
                <span
                  className="design-preset-swatch"
                  style={presetSwatchStyle(preset.design)}
                  aria-hidden="true"
                >
                  Ag
                </span>
                <span className="design-preset-name">{preset.name}</span>
                <span className="design-preset-description">
                  {preset.description}
                </span>
              </label>
            ))}
          </fieldset>
        </section>

        {groups.map((group) => (
          <section
            className="design-section"
            key={group.title}
            aria-labelledby={groupHeadingId(groupHeadingPrefix, group.title)}
          >
            <h2 id={groupHeadingId(groupHeadingPrefix, group.title)}>
              {group.title}
            </h2>
            <p className="design-section-help">{group.help}</p>
            {group.controls.map((control) => (
              <fieldset
                className="design-control"
                key={control.path}
                data-field-path={control.path}
                style={
                  {
                    "--option-columns": optionColumns(control.options.length),
                  } as CSSProperties
                }
              >
                <legend>{control.label}</legend>
                <p className="design-control-help">{control.help}</p>
                <div className="design-options">
                  {control.options.map((option) => (
                    <DesignOptionCard
                      key={option.value}
                      control={control}
                      option={option}
                      disabled={disabled}
                      onChoose={(value) =>
                        onEdit({ path: control.path, value })
                      }
                    />
                  ))}
                </div>
              </fieldset>
            ))}
          </section>
        ))}
      </div>

      <div className="design-preview">
        <div className="design-preview-head">
          <h2>Your site</h2>
          {/* Says plainly what this picture is and is not. It is drawn at a
            * desktop width and shrunk to fit, so heading sizes and margins are
            * close rather than exact, and it never shows the phone layout. The
            * toolbar's Preview button opens the real page. */}
          <p>
            Every change shows here straight away. This is a guide to how your
            choices look, drawn at desktop width. Use Preview for the exact
            page. Nothing reaches the live site until you publish.
          </p>
        </div>
        <div className="design-preview-window" ref={previewScale.ref}>
          <div
            className="design-preview-page"
            style={
              {
                "--preview-scale": previewScale.scale,
                "--preview-width": `${previewLayoutWidth}px`,
              } as CSSProperties
            }
            /* The preview is a picture of the site, not a second copy of it to
             * read or operate with a keyboard. The real site is one landmark
             * away in the toolbar's Preview button. */
            aria-hidden="true"
            inert
          >
            <SiteRenderer definition={definition} editingSurface />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * How far the preview must shrink to fit its column. The site is laid out at a
 * fixed desktop width so the content-width control has something to show, then
 * scaled down to whatever room the column has.
 */
function usePreviewScale() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const measure = useCallback((element: HTMLDivElement) => {
    const width = element.clientWidth;
    if (width > 0) {
      setScale(Math.min(1, width / previewLayoutWidth));
    }
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    measure(element);
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => measure(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  return { ref, scale };
}
