# NixOS module: Sleipnyr 2 (kernel + plugins on Bun), its speech-to-text
# and text-to-speech sidecars, and HTTPS on the tailnet through `tailscale serve`.
#
# The code is deployed as release folders by deploy/deploy.sh into
# ${stateDir}/releases/<sha>, with ${stateDir}/releases/current pointing at
# one; this module only runs whatever "current" is. Data lives in
# ${stateDir}/data. Secrets: an environment file (not in the Nix store) that
# defines the variables named by the config's keyEnv entries.
{ config, lib, pkgs, ... }:
let
  cfg = config.services.sleipnyr2;
  json = pkgs.formats.json { };
  stt = pkgs.python3.withPackages (ps: [ ps.faster-whisper ps.numpy ]);
  tts = pkgs.python3.withPackages (ps: [ ps.kokoro ps.numpy ps.spacy-models.en_core_web_sm ]);
  appConfig = json.generate "sleipnyr2-config.json" (lib.recursiveUpdate {
    listen = { host = "127.0.0.1"; port = cfg.port; };
    dataDir = "${cfg.stateDir}/data";
    plugins."transcribe-http".url = "http://127.0.0.1:${toString cfg.transcribePort}/api/transcribe";
    plugins.talk = {
      hearUrl = "http://127.0.0.1:${toString cfg.transcribePort}/api/transcribe?fast=1";
      speakUrl = "http://127.0.0.1:${toString cfg.speakPort}/api/speak";
    };
  } cfg.settings);
  hardening = {
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectControlGroups = true;
    RestrictNamespaces = true;
    LockPersonality = true;
    CapabilityBoundingSet = "";
    RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
    SystemCallFilter = [ "@system-service" ];
  };
in
{
  options.services.sleipnyr2 = {
    enable = lib.mkEnableOption "Sleipnyr 2";
    port = lib.mkOption { type = lib.types.port; default = 8180; };
    transcribePort = lib.mkOption { type = lib.types.port; default = 8181; };
    speakPort = lib.mkOption { type = lib.types.port; default = 8182; };
    tailscalePort = lib.mkOption {
      type = lib.types.nullOr lib.types.port;
      default = null;
      description = "Publish on the tailnet at https://<host>:<port> (null = loopback only).";
    };
    stateDir = lib.mkOption { type = lib.types.str; default = "/var/lib/sleipnyr2"; };
    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Root-only file with the agent keys (KEY=value lines).";
    };
    settings = lib.mkOption {
      type = json.type;
      default = { };
      description = "Merged into the app config (see config.example.json).";
    };
    transcribe = {
      model = lib.mkOption { type = lib.types.str; default = "small"; };
      fastModel = lib.mkOption { type = lib.types.str; default = "base.en"; description = "For hands-free talk turns."; };
      prompt = lib.mkOption { type = lib.types.str; default = ""; description = "Names and jargon to expect."; };
    };
    speak.voice = lib.mkOption { type = lib.types.str; default = "am_michael"; description = "Kokoro voice."; };
  };

  config = lib.mkIf cfg.enable {
    users.users.sleipnyr2 = { isSystemUser = true; group = "sleipnyr2"; home = cfg.stateDir; };
    users.groups.sleipnyr2 = { };

    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0750 sleipnyr2 sleipnyr2 -"
      "d ${cfg.stateDir}/data 0750 sleipnyr2 sleipnyr2 -"
      "d ${cfg.stateDir}/releases 0755 root root -"
      "d ${cfg.stateDir}/models 0750 sleipnyr2 sleipnyr2 -"
    ];

    systemd.services.sleipnyr2 = {
      description = "Sleipnyr 2";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" "sleipnyr2-transcribe.service" "sleipnyr2-speak.service" ];
      wants = [ "sleipnyr2-transcribe.service" "sleipnyr2-speak.service" ];
      unitConfig.ConditionPathExists = "${cfg.stateDir}/releases/current/kernel/server.ts";
      environment.SLEIPNYR2_CONFIG = "${appConfig}";
      # voice uploads get fresh timestamps (kernel/server.ts fixAudio)
      environment.SLEIPNYR2_FFMPEG = "${pkgs.ffmpeg-headless}/bin/ffmpeg";
      serviceConfig = hardening // {
        ExecStart = "${pkgs.bun}/bin/bun ${cfg.stateDir}/releases/current/kernel/server.ts";
        WorkingDirectory = cfg.stateDir;
        User = "sleipnyr2";
        Group = "sleipnyr2";
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        ReadWritePaths = [ "${cfg.stateDir}/data" ];
        IPAddressAllow = [ "localhost" ];
        IPAddressDeny = "any";
        Restart = "always";
        RestartSec = 3;
        MemoryMax = "1G";
        # bun's JIT needs writable+executable memory
        MemoryDenyWriteExecute = false;
      };
    };

    systemd.services.sleipnyr2-transcribe = {
      description = "Sleipnyr 2 speech to text";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      unitConfig.ConditionPathExists = "${cfg.stateDir}/releases/current/tools/transcribe/transcribe.py";
      environment = {
        TRANSCRIBE_HOST = "127.0.0.1";
        TRANSCRIBE_PORT = toString cfg.transcribePort;
        TRANSCRIBE_MODEL = cfg.transcribe.model;
        TRANSCRIBE_FAST_MODEL = cfg.transcribe.fastModel;
        TRANSCRIBE_PROMPT = cfg.transcribe.prompt;
        TRANSCRIBE_FFMPEG = "${pkgs.ffmpeg-headless}/bin/ffmpeg";
        HF_HOME = "${cfg.stateDir}/models";
        PYTHONUNBUFFERED = "1";
      };
      serviceConfig = hardening // {
        ExecStart = "${stt}/bin/python3 ${cfg.stateDir}/releases/current/tools/transcribe/transcribe.py";
        WorkingDirectory = cfg.stateDir;
        User = "sleipnyr2";
        Group = "sleipnyr2";
        ReadWritePaths = [ "${cfg.stateDir}/models" ];
        # the model is downloaded once from Hugging Face, so no IP restriction here
        Restart = "always";
        RestartSec = 5;
        MemoryMax = "3G";
        Nice = 5;
      };
    };

    systemd.services.sleipnyr2-speak = {
      description = "Sleipnyr 2 text to speech (Kokoro)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      unitConfig.ConditionPathExists = "${cfg.stateDir}/releases/current/tools/speak/speak.py";
      environment = {
        SPEAK_HOST = "127.0.0.1";
        SPEAK_PORT = toString cfg.speakPort;
        SPEAK_VOICE = cfg.speak.voice;
        SPEAK_THREADS = "4";
        HF_HOME = "${cfg.stateDir}/models";
        XDG_CACHE_HOME = "${cfg.stateDir}/models/cache"; # torch and spaCy caches
        PYTHONUNBUFFERED = "1";
      };
      serviceConfig = hardening // {
        ExecStart = "${tts}/bin/python3 ${cfg.stateDir}/releases/current/tools/speak/speak.py";
        WorkingDirectory = cfg.stateDir;
        User = "sleipnyr2";
        Group = "sleipnyr2";
        ReadWritePaths = [ "${cfg.stateDir}/models" ];
        # the model is downloaded once from Hugging Face, so no IP restriction here
        Restart = "always";
        RestartSec = 5;
        MemoryMax = "3G";
      };
    };

    systemd.services.sleipnyr2-serve = lib.mkIf (cfg.tailscalePort != null) {
      description = "tailscale serve :${toString cfg.tailscalePort} -> Sleipnyr 2";
      wantedBy = [ "multi-user.target" ];
      after = [ "tailscaled.service" ];
      requires = [ "tailscaled.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${config.services.tailscale.package}/bin/tailscale serve --bg --https=${toString cfg.tailscalePort} http://127.0.0.1:${toString cfg.port}";
        ExecStop = "${config.services.tailscale.package}/bin/tailscale serve --https=${toString cfg.tailscalePort} off";
        Restart = "on-failure";
        RestartSec = 10;
      };
    };
  };
}
