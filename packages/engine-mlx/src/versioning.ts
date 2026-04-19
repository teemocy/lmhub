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

export function parseMlxVersionTag(versionTag: string): MlxRuntimeVersionSpec | undefined {
  const match =
    /^py(?<pythonDigits>\d+)-mlx(?<mlxVersion>[0-9][0-9A-Za-z.+-]*)-mlx-lm(?<mlxLmVersion>[0-9][0-9A-Za-z.+-]*)$/.exec(
      versionTag,
    );

  const pythonDigits = match?.groups?.pythonDigits;
  const mlxVersion = match?.groups?.mlxVersion;
  const mlxLmVersion = match?.groups?.mlxLmVersion;
  if (!pythonDigits || !mlxVersion || !mlxLmVersion) {
    return undefined;
  }

  const pythonVersion =
    pythonDigits.length > 1 ? `${pythonDigits.slice(0, 1)}.${pythonDigits.slice(1)}` : pythonDigits;

  return {
    pythonVersion,
    mlxVersion,
    mlxLmVersion,
  };
}
