var Fluorite = {
  manifest: {
    id: "hello-world",
    name: "Hello World",
    version: "1.0.0",
    license: "MIT",
    description: "A simple hello world extension",
  },
};

class HelloWorld {
  getInfo() {
    return { id: "hello-world", name: "Hello World", blocks: [] };
  }
}

Scratch.extensions.register(new HelloWorld());
