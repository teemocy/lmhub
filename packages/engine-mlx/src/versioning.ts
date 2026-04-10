export const DEFAULT_MLX_PYTHON_VERSION = "3.12";
export const DEFAULT_MLX_VERSION = "0.31.1";
export const DEFAULT_MLX_LM_VERSION = "0.31.2";

export interface MlxRuntimeVersionSpec {
  pythonVersion: string;
  mlxVersion: string;
  mlxLmVersion: string;
}

export function buildMlxVersionTag(spec: MlxRuntimeVersionSpec): string {
  return `py${spec.pythonVersion.replace(/\./g, "")}-mlx${spec.mlxVersion}-mlx-lm${spec.mlxLmVersion}`;
}
