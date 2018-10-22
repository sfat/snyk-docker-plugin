import { Docker } from '../docker';
import { AnalyzerPkg } from './types';
import * as resolveNpmDeps from 'snyk-resolve-deps';

export {
  analyze,
};

function analyze(targetImage: string) {
  // TODO some hardcoded path
  // TODO ADD some target image logic here?
  const path = '/tmp/foo';
  return resolveNpmDeps(path)
    .then(tree => {
      tree.targetFile = 'package.json';
      tree.type = 'npm';
      return tree;
    });
}
