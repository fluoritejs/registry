(function (Scratch) {
  "use strict";

  const Fluorite = {
    meta: {
      class: "HelloWorld",
      name: "It works!",
      id: "helloworld",
      license: "LGPL-2.1",
      authors: [
        { name: "Author 1", url: "https://example.com" },
        { name: "Author 2" },
      ],
      description: "A description of the extension.",
      version: "0.1.0",
    },
    assets: {
      "hello-icon.svg":
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij4KICA8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgZmlsbD0iIzRDOTdGRiIgLz4KPC9zdmc+Cg==",
    },
  };

  class HelloWorld {
    getInfo() {
      return {
        id: Fluorite.meta.id,
        name: Fluorite.meta.name,
        blockIconURI: Fluorite.assets["hello-icon.svg"],
        blocks: [
          {
            opcode: "hello",
            blockType: Scratch.BlockType.REPORTER,
            text: "Hello!",
          },
        ],
      };
    }

    hello() {
      return "World!";
    }
  }

  Scratch.extensions.register(new HelloWorld());
})(Scratch);
