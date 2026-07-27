import type {
  RichTextDocument,
  RichTextLinkMark,
  RichTextParagraph,
  RichTextText,
} from "@foundry/site-definition";

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
}: {
  document: RichTextDocument;
}) {
  return document.children.map((block, blockIndex) => {
    switch (block.type) {
      case "paragraph":
        return <Paragraph key={blockIndex} node={block} />;
      case "heading": {
        const Tag = `h${block.level}` as "h1";
        return (
          <Tag key={blockIndex}>
            {block.children.map((child, index) => (
              <Text key={index} node={child} />
            ))}
          </Tag>
        );
      }
      case "blockquote":
        return (
          <blockquote key={blockIndex}>
            {block.children.map((child, index) => (
              <Paragraph key={index} node={child} />
            ))}
          </blockquote>
        );
      case "bulletList":
      case "orderedList": {
        const List = block.type === "bulletList" ? "ul" : "ol";
        return (
          <List key={blockIndex}>
            {block.children.map((item, itemIndex) => (
              <li key={itemIndex}>
                {item.children.map((child, index) => (
                  <Paragraph key={index} node={child} />
                ))}
              </li>
            ))}
          </List>
        );
      }
    }
  });
}
