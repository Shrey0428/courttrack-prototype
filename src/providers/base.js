class BaseProvider {
  constructor(name) {
    this.name = name;
  }

  async fetchCase(_input) {
    throw new Error('fetchCase() must be implemented by provider');
  }
}

module.exports = BaseProvider;
