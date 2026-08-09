import {
  visitRichTextBlock,
  type RichTextDocument,
  type RichTextLinkMark,
  type RichTextParagraph,
  type RichTextText,
} from "@humber-foundry/site-definition";

function Text({ node }: { node: RichTextText }) {
  let content = <>{node.text}</>;
  if (node.marks.includes("bold")) {
    content = <strong>{content}</strong>;
  }
  if (node.marks.includes("italic")) {
    content = <em>{content}</em>;
  }
  const link = node.marks.find(
    (mark): mark is RichTextLinkMark =>
      typeof mark === "object" && mark.type === "link",
  );
  return link === undefined ? content : <a href={link.href}>{content}</a>;
}

function Paragraph({ node }: { node: RichTextParagraph }) {
  return (
    <p>
      {node.children.map((child, index) => (
        <Text key={index} node={child} />
      ))}
    </p>
  );
}

export function RichTextRenderer({
  document,
  headingOffset = 0,
}: {
  document: RichTextDocument;
  headingOffset?: number;
}) {
  return document.children.map((block, blockIndex) =>
    visitRichTextBlock(block, {
      paragraph: (paragraph) => (
        <Paragraph key={blockIndex} node={paragraph} />
      ),
      heading: (heading) => {
        const renderedLevel = Math.min(6, heading.level + headingOffset);
        const Tag = `h${renderedLevel}` as "h1";
        return (
          <Tag key={blockIndex}>
            {heading.children.map((child, index) => (
              <Text key={index} node={child} />
            ))}
          </Tag>
        );
      },
      blockquote: (blockquote) => (
          <blockquote key={blockIndex}>
            {blockquote.children.map((child, index) => (
              <Paragraph key={index} node={child} />
            ))}
          </blockquote>
        ),
      bulletList: (list) => (
        <ul key={blockIndex}>
          {list.children.map((item, itemIndex) => (
            <li key={itemIndex}>
              <Paragraph node={item.children[0]!} />
            </li>
          ))}
        </ul>
      ),
      orderedList: (list) => (
        <ol key={blockIndex}>
          {list.children.map((item, itemIndex) => (
            <li key={itemIndex}>
              <Paragraph node={item.children[0]!} />
            </li>
          ))}
        </ol>
      ),
    }),
  );
}
