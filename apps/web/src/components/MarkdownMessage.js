import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * MarkdownMessage — renders the coach's reply as GitHub-flavoured
 * Markdown (tables, lists, code, links). Raw HTML is NOT enabled
 * (no rehype-raw), so model output can't inject markup — react-markdown
 * escapes it by default.
 *
 * Element styling lives in `.gc-md` (index.css). Only the table and link
 * need component overrides: tables get a horizontal-scroll wrapper (UI/UX
 * guidance: "wide tables must not break the layout"), and links open in a
 * new tab.
 */
export default function MarkdownMessage({ content }) {
  return (
    <div data-testid="markdown-message" className="gc-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: (props) => (
            <div className="gc-md-table-wrap">
              <table {...props} />
            </div>
          ),
          a: ({ href, ...props }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...props} />
          ),
        }}
      >
        {String(content ?? "")}
      </ReactMarkdown>
    </div>
  );
}
