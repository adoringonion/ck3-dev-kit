export class QueryEngine {
  private readonly values = new Map<string, unknown>();
  private readonly deps = new Map<string, Set<string>>();
  private readonly reverseDeps = new Map<string, Set<string>>();
  private readonly tags = new Map<string, Set<string>>();
  private readonly reverseTags = new Map<string, Set<string>>();
  private readonly active: string[] = [];

  evaluate<T>(key: string, compute: () => T, tags?: Iterable<string>): T {
    this.recordDependency(key);
    if (tags) {
      this.recordTags(key, tags);
    }
    if (this.values.has(key)) {
      return this.values.get(key) as T;
    }
    this.active.push(key);
    try {
      const value = compute();
      this.values.set(key, value);
      return value;
    } finally {
      this.active.pop();
    }
  }

  invalidate(key: string): void {
    const pending = [key];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      this.values.delete(current);
      const dependents = [...(this.reverseDeps.get(current) ?? [])];
      this.removeQueryMetadata(current);
      for (const dependent of dependents) {
        pending.push(dependent);
      }
    }
  }

  clear(): void {
    this.values.clear();
    this.deps.clear();
    this.reverseDeps.clear();
    this.tags.clear();
    this.reverseTags.clear();
    this.active.length = 0;
  }

  stats(): {
    valueCount: number;
    dependencyEdgeCount: number;
    reverseDependencyEdgeCount: number;
    tagCount: number;
    taggedQueryCount: number;
  } {
    let dependencyEdgeCount = 0;
    for (const deps of this.deps.values()) {
      dependencyEdgeCount += deps.size;
    }
    let reverseDependencyEdgeCount = 0;
    for (const deps of this.reverseDeps.values()) {
      reverseDependencyEdgeCount += deps.size;
    }
    let taggedQueryCount = 0;
    for (const tagged of this.reverseTags.values()) {
      taggedQueryCount += tagged.size;
    }
    return {
      valueCount: this.values.size,
      dependencyEdgeCount,
      reverseDependencyEdgeCount,
      tagCount: this.reverseTags.size,
      taggedQueryCount,
    };
  }

  markDirty(key: string): void {
    this.invalidate(key);
  }

  markDirtyTag(tag: string): void {
    const tagged = this.reverseTags.get(tag);
    if (!tagged) {
      return;
    }
    for (const key of [...tagged]) {
      this.invalidate(key);
    }
  }

  private recordDependency(key: string): void {
    const parent = this.active[this.active.length - 1];
    if (!parent || parent === key) {
      return;
    }
    const currentDeps = this.deps.get(parent) ?? new Set<string>();
    currentDeps.add(key);
    this.deps.set(parent, currentDeps);

    const dependents = this.reverseDeps.get(key) ?? new Set<string>();
    dependents.add(parent);
    this.reverseDeps.set(key, dependents);
  }

  private recordTags(key: string, tags: Iterable<string>): void {
    for (const tag of tags) {
      const currentTags = this.tags.get(key) ?? new Set<string>();
      if (!currentTags.has(tag)) {
        currentTags.add(tag);
        this.tags.set(key, currentTags);
      }

      const taggedQueries = this.reverseTags.get(tag) ?? new Set<string>();
      if (!taggedQueries.has(key)) {
        taggedQueries.add(key);
        this.reverseTags.set(tag, taggedQueries);
      }
    }
  }

  private removeQueryMetadata(key: string): void {
    const dependencies = this.deps.get(key);
    if (dependencies) {
      for (const dependency of dependencies) {
        const dependents = this.reverseDeps.get(dependency);
        if (!dependents) {
          continue;
        }
        dependents.delete(key);
        if (dependents.size === 0) {
          this.reverseDeps.delete(dependency);
        }
      }
      this.deps.delete(key);
    }

    const tags = this.tags.get(key);
    if (tags) {
      for (const tag of tags) {
        const taggedQueries = this.reverseTags.get(tag);
        if (!taggedQueries) {
          continue;
        }
        taggedQueries.delete(key);
        if (taggedQueries.size === 0) {
          this.reverseTags.delete(tag);
        }
      }
      this.tags.delete(key);
    }
  }
}
