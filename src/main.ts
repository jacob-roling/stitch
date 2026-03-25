import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Console from "effect/Console";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";
// import * as FileSystem from "effect/FileSystem";
// import * as Stdio from "effect/Stdio";
// import * as Schedule from "effect/Schedule";
// import * as Cause from "effect/Cause";
// import * as Terminal from "effect/Terminal";
// import * as Result from "effect/Result";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";

const VIDEO_EXTENSIONS = new Set([
  // Common
  ".mp4",
  ".m4v",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  // Windows
  ".wmv",
  ".asf",
  // Apple
  ".m4b",
  ".m4p",
  // MPEG
  ".mpg",
  ".mpeg",
  ".m2v",
  ".m2p",
  ".m2ts",
  ".mts",
  ".ts",
  // Flash / older web
  ".flv",
  ".f4v",
  // Real
  ".rmvb",
  ".rm",
  // 3GPP (mobile)
  ".3gp",
  ".3g2",
  // Misc
  ".ogv",
  ".vob",
  ".divx",
  ".xvid",
  ".dv",
  ".mxf",
]);

const path = Flag.string("path").pipe(
  Flag.withAlias("p"),
  Flag.atLeast(1),
  Flag.withDescription("Path to a video file"),
);

function selectFiles(
  options?:
    | ({ messageFn: (index: number) => string } & Prompt.FileOptions)
    | undefined,
) {
  return Stream.fromEffectRepeat(Effect.succeed(undefined)).pipe(
    Stream.mapEffect((_, index) =>
      Effect.gen(function* () {
        const selectedFile = yield* Prompt.run(
          Prompt.file({
            message: options ? options.messageFn(index) : undefined,
            ...options,
          }),
        );
        return selectedFile;
      }),
    ),
    Stream.ignoreCause,
  );
}

function hasAudio(videoPath: string) {
  return Effect.gen(function* () {
    const cp = yield* ChildProcess.make("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-select_streams",
      "a",
      "-of",
      "json",
      videoPath,
    ]);
    const stdout = yield* cp.stdout.pipe(
      Stream.decodeText(),
      Stream.runCollect,
    );
    const json = JSON.parse(stdout.join(""));
    return json.streams && json.streams.length > 0;
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

function stitchVideos(videoPaths: string[], outputPath: string) {
  return Effect.gen(function* () {
    if (videoPaths.length < 1) return;

    const pathTool = yield* Path.Path;
    yield* Console.log(`\n🎬 Stitching ${videoPaths.length} files...`);

    // 1. Audio Check (Essential to prevent concat crashes)
    const audioStatuses = yield* Effect.all(
      videoPaths.map((p) => hasAudio(pathTool.resolve(p))),
      { concurrency: "unbounded" },
    );

    const filterParts: string[] = [];

    videoPaths.forEach((_, i) => {
      // VIDEO: Scale, Pad, FPS, Format.
      const v = `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`;

      // AUDIO: loudnorm is the robust modern standard for normalization
      const a = audioStatuses[i]
        ? `[${i}:a]aresample=44100:async=1,aformat=sample_rates=44100:channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11[a${i}]`
        : `anullsrc=channel_layout=stereo:sample_rate=44100[a${i}]`;

      filterParts.push(v, a);
    });

    const concatInputs = videoPaths.map((_, i) => `[v${i}][a${i}]`).join("");
    const concatFinal = `${concatInputs}concat=n=${videoPaths.length}:v=1:a=1[v][a]`;

    const filterString = [...filterParts, concatFinal].join(";");

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...videoPaths.flatMap((p) => ["-i", pathTool.resolve(p)]),
      "-filter_complex",
      filterString,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-crf",
      "23",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-pix_fmt",
      "yuv420p",
      pathTool.resolve(outputPath),
    ];

    const ffmpegHandle = yield* ChildProcess.make("ffmpeg", args, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = yield* ffmpegHandle.exitCode;

    if (exitCode !== 0) {
      yield* Console.error(
        "\n❌ Stitching failed. Try updating FFmpeg or check the filter string below:",
      );
      yield* Console.log(filterString);
      return yield* Effect.fail(
        new Error(`FFmpeg failed with exit code ${exitCode}`),
      );
    }

    yield* Console.log(`\n✅ Saved to: ${outputPath}`);
  }).pipe(Effect.scoped);
}

function checkDependencies() {
  return Effect.gen(function* () {
    const check = (bin: string) =>
      ChildProcess.make(bin, ["-version"]).pipe(
        // @ts-ignore
        Effect.flatMap((cp) => cp.exitCode),
        Effect.mapError(
          () => new Error(`Missing dependency: ${bin} is not installed.`),
        ),
        Effect.ignore,
      );

    yield* Effect.all([check("ffmpeg"), check("ffprobe")], {
      discard: true,
    }).pipe(
      Effect.mapError(
        () => new Error("Required dependencies (ffmpeg, ffprobe) not found."),
      ),
    );
  });
}

const sequenceCommand = Command.make(
  "sequence",
  {
    outputPath: Flag.file("output").pipe(
      Flag.withAlias("o"),
      Flag.withDescription("Where to save the final output."),
    ),
    startingPath: Flag.directory("directory").pipe(
      Flag.withAlias("d"),
      Flag.withDefault("."),
      Flag.withDescription("Where to start searching for video files."),
    ),
  },
  ({ outputPath, startingPath }) =>
    Effect.gen(function* () {
      // yield* checkDependencies();

      const path = yield* Path.Path;

      yield* Console.log(
        "Select videos in the order you would like them stitched together. Then press Ctrl+C.",
      );

      const videoPaths = yield* selectFiles({
        messageFn(index) {
          return `Select video #${index + 1}`;
        },
        startingPath,
        type: "file",
        filter(file) {
          return Effect.gen(function* () {
            const parts = path.parse(file);
            return VIDEO_EXTENSIONS.has(parts.ext.toLowerCase());
          });
        },
      }).pipe(Stream.runCollect);

      yield* stitchVideos(videoPaths, outputPath);
    }),
);

const stitch = Command.make("stitch").pipe(
  Command.withSubcommands([sequenceCommand]),
);

const program = Command.run(stitch, {
  version: "0.0.1",
});

BunRuntime.runMain(
  program.pipe(
    Effect.catch((error) => Console.error(`\nError: ${error.message}`)),
    Effect.provide(Layer.mergeAll(BunServices.layer)),
  ),
);
