var Fluorite = {
  manifest: {
    id: "test-ext",
    name: "Test Extension",
    version: "2.1.0",
    license: "Apache-2.0",
    description: "Extension for testing manifest extraction",
  },
};

class TestExt {
  getInfo() {
    return { id: "test-ext", name: "Test Extension", blocks: [] };
  }
}

Scratch.extensions.register(new TestExt());
