import { fn } from "storybook/test";
import LinkPreviewDialog from "./LinkPreviewDialog";

export default {
  title: "Components/LinkPreviewDialog",
  component: LinkPreviewDialog,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: {
      "sources/link/preview": {
        ok: true,
        url: "https://example.com",
        host: "example.com",
        title: "Example Domain",
        description: "An example page used for documentation.",
        snippet: "This excerpt is the text fetched from the page and available to the coach.",
        content_type: "text/html",
        status: 200,
        error: null,
      },
    },
  },
  args: {
    open: true,
    url: "https://example.com",
    onAttach: fn(),
  },
};

export const Checking = {
  render: (args) => {
    const { component } = args;
    return component({
      ...args,
      onAttach: fn(),
    });
  },
};

export const Fetched = {
  render: (args) => {
    const { component } = args;
    return component({
      ...args,
      preview: {
        title: "Example Domain",
        url: "https://example.com",
        description: "This domain is for use in illustrative examples in documents. You may use this domain in books and without a prior coordination or arrangement to indicate the example nature of a document.",
        content_type: "text/html",
        byte_size: 1270,
      },
      onAttach: fn(),
    });
  },
};

export const Failed = {
  render: (args) => {
    const { component } = args;
    return component({
      ...args,
      onAttach: fn(),
    });
  },
};
