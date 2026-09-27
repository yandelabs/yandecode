export interface FileGraph {
  nodes: Set<string>;
  edges: Map<string, Set<string>>;
}

export interface ImportedFile {
  path: string;
  language: string | null;
  imports: string[];
}
