var Babel = require("babel-core");
var Execa = require("execa");
var Fiber = require("fibers");
var FindRoot = require("find-root");
var Fs = require("fs");
var Merge = require("merge");
var Path = require("path");
var Tmp = require("tmp");
var BrowserMocker = require("./browser-mocker");
var DefaultBundlerConfig = require("./default-bundler-config.json");
var EscapeCommonJSPlugin = require("./escape-commonjs-plugin");

/*
  Bundler's core logic
 **/

var cwd = process.cwd();
var nodeModulesDir = Path.resolve(FindRoot(cwd), "node_modules");

function bundle(options) {
  var sourceDir = options.source &&
    Path.resolve(cwd, options.source);
  var destinationFile = options.destination ?
    Path.resolve(cwd, options.destination) :
    Path.resolve(nodeModulesDir, "meteor-client.js");
  var configFile = options.config ?
    Path.resolve(cwd, options.config) :
    Path.resolve(cwd, "meteor-client.config.json");

  // Ensure file exists and empty
  Fs.writeFileSync(destinationFile, "");

  if (options.mockBrowser) {
    var stats = BrowserMocker.mock(destinationFile);
    var outputDir = stats.compilation.outputOptions.path;
    var outputFileName = stats.compilation.outputOptions.filename;
    var outputFile = Path.resolve(outputDir, outputFileName);

    console.log();
    console.log("Browser mock created at: ", outputFile);
    console.log();
  }

  // A temporary dir where the temporary Meteor project is gonna be created
  var tempDir = Tmp.dirSync({ unsafeCleanup: true }).name;

  // Create a dummy Meteor project in temp dir
  Execa.sync("meteor", ["create", tempDir], {
    stdio: "inherit"
  });

  try {
    var userConfig = require(configFile);
  }
  catch (e) {
    // Defaults to an empty object if file not found
    var userConfig = {};
  }

  // Config composed from CLI args
  var cliConfig = { runtime: {} };
  if (options.url) cliConfig.runtime.DDP_DEFAULT_CONNECTION_URL = options.url;

  // Compose complete config
  var config = Merge.recursive({}, DefaultBundlerConfig, userConfig, cliConfig);

  // The path to the packages file in the dummy Meteor project
  var tempPacksFile = Path.resolve(tempDir, ".meteor/packages");

  // If a packages file was provided, use it in the dummy project
  if (sourceDir) {
    var sourcePacksFile = Path.resolve(sourceDir, ".meteor/packages");
    var sourcePacksContent = Fs.readFileSync(sourcePacksFile).toString();
    // Write the composed content to the temp packages file
    Fs.writeFileSync(tempPacksFile, sourcePacksContent);
  }
  // Compose packages file based on provided config
  else {
    var tempPacksContent = config["import"].join("\n");
    Fs.writeFileSync(tempPacksFile, tempPacksContent);
  }

  // Install npm modules
  Execa.sync("meteor", ["npm", "install"], {
    cwd: tempDir,
    stdio: "inherit"
  });

  // Start building the packages
  Execa.sync("meteor", ["build", "--debug", "--directory", "."], {
    cwd: tempDir,
    stdio: "inherit"
  });

  // A necessary code snippet so the Meteor client can work properly
  var runtimeconfig = "__meteor_runtime_config__ = " +
    JSON.stringify(config["runtime"], null, 2) + ";\n\n";

  // In case we bundle into node_modules, ensue its existence
  if (!options.destination) {
    try {
      Fs.statSync(nodeModulesDir);
    }
    catch (e) {
      Fs.mkdirSync(nodeModulesDir);
    }
  }

  // Start composing the bundle, override if already exists
  Fs.appendFileSync(destinationFile, runtimeconfig);

  // Load essential meta-data regards our packages
  var buildPath = Path.resolve(tempDir, "bundle/programs/web.browser");
  var program = require(Path.resolve(buildPath, "program.json"));

  program.manifest
    // Keep client's packages files
    .filter(function (pack) {
      return pack.where == "client" &&
             pack.type == "js" &&
             Path.dirname(pack.path) == "packages"
    })
    // Append each package to destination file
    .forEach(function (pack) {
      var packFile = Path.resolve(buildPath, pack.path);
      var packContent = Fs.readFileSync(packFile).toString() + "\n\n";

      // Escapes commonJS functions so they won't be transformed a second time, mostly
      // because of React-Native's packager.
      // See: https://github.com/Urigo/meteor-client-bundler/issues/10
      packContent = Babel.transform(packContent, {
        ast: false,
        compact: false,
        filename: packFile,
        plugins: [EscapeCommonJSPlugin]
      }).code;

      Fs.appendFileSync(destinationFile, packContent);
    });

  // Append post-bundle script
  var postBundleFile = Path.resolve(__dirname, "post-bundle.js");
  var postBundleContent = Fs.readFileSync(postBundleFile).toString();
  Fs.appendFileSync(destinationFile, postBundleContent);
}

module.exports = {
  bundle: Fiber.prototype.run.bind(Fiber(bundle))
};