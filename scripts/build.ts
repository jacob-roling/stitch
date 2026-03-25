import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import pkg from "../package.json" with { type: "json" };

function build(config: Bun.BuildConfig) {
  return Effect.promise(() => Bun.build(config));
}

const entrypoints = ["./src/main.ts"];
const target = "bun";

const program = Effect.gen(function* () {
  yield* build({
    entrypoints,
    target,
    compile: {
      target: "bun-windows-x64-modern",
      outfile: pkg.name,
      windows: {
        title: pkg.name,
        description: pkg.description,
        version: pkg.version,
        hideConsole: false,
      },
    },
    outdir: "./builds/windows-x64",
  });

  yield* build({
    entrypoints,
    target,
    compile: {
      target: "bun-linux-x64-modern",
      outfile: pkg.name,
    },
    outdir: "./builds/linux-x64",
  });
});

BunRuntime.runMain(
  program.pipe(Effect.provide(Layer.mergeAll(BunServices.layer))),
);
