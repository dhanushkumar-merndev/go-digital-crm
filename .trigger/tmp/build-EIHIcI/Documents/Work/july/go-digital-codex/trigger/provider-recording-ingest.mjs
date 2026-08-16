import {
  init_protocols,
  protocols_exports,
  require_dist_cjs
} from "../../../../../chunk-CJ3ZKOD2.mjs";
import {
  endpoints_exports,
  init_endpoints
} from "../../../../../chunk-F3IKMDDZ.mjs";
import {
  createClient,
  dist_exports
} from "../../../../../chunk-YD4LEPU7.mjs";
import {
  task
} from "../../../../../chunk-JF2PC2IM.mjs";
import {
  __commonJS,
  __name,
  __require,
  __toCommonJS,
  __toESM,
  init_esm
} from "../../../../../chunk-265QJBBL.mjs";

// node_modules/.pnpm/@aws-sdk+lib-storage@3.1110.0_@aws-sdk+client-s3@3.1110.0/node_modules/@aws-sdk/lib-storage/dist-cjs/index.js
var require_dist_cjs2 = __commonJS({
  "node_modules/.pnpm/@aws-sdk+lib-storage@3.1110.0_@aws-sdk+client-s3@3.1110.0/node_modules/@aws-sdk/lib-storage/dist-cjs/index.js"(exports) {
    init_esm();
    var { PutObjectCommand, ChecksumAlgorithm, CreateMultipartUploadCommand, AbortMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, PutObjectTaggingCommand } = require_dist_cjs();
    var { toEndpointV1, getEndpointFromInstructions } = (init_endpoints(), __toCommonJS(endpoints_exports));
    var { extendedEncodeURIComponent } = (init_protocols(), __toCommonJS(protocols_exports));
    var { EventEmitter } = __require("events");
    var { Buffer } = __require("buffer");
    var { lstatSync, ReadStream } = __require("node:fs");
    var { Readable: Readable2 } = __require("stream");
    var runtimeConfigShared = {
      lstatSync: /* @__PURE__ */ __name(() => {
      }, "lstatSync"),
      isFileReadStream(f) {
        return false;
      }
    };
    var runtimeConfig = {
      ...runtimeConfigShared,
      runtime: "node",
      lstatSync,
      isFileReadStream(f) {
        return f instanceof ReadStream;
      }
    };
    var byteLength = /* @__PURE__ */ __name((input) => {
      if (input == null) {
        return 0;
      }
      if (typeof input === "string") {
        return Buffer.byteLength(input);
      }
      if (typeof input.byteLength === "number") {
        return input.byteLength;
      } else if (typeof input.length === "number") {
        return input.length;
      } else if (typeof input.size === "number") {
        return input.size;
      } else if (typeof input.start === "number" && typeof input.end === "number") {
        return input.end + 1 - input.start;
      } else if (runtimeConfig.isFileReadStream(input)) {
        try {
          return runtimeConfig.lstatSync(input.path).size;
        } catch (error) {
          return void 0;
        }
      }
      return void 0;
    }, "byteLength");
    var BYTE_LENGTH_SOURCE;
    (function(BYTE_LENGTH_SOURCE2) {
      BYTE_LENGTH_SOURCE2["EMPTY_INPUT"] = "a null or undefined Body";
      BYTE_LENGTH_SOURCE2["CONTENT_LENGTH"] = "the ContentLength property of the params set by the caller";
      BYTE_LENGTH_SOURCE2["STRING_LENGTH"] = "the encoded byte length of the Body string";
      BYTE_LENGTH_SOURCE2["TYPED_ARRAY"] = "the byteLength of a typed byte array such as Uint8Array";
      BYTE_LENGTH_SOURCE2["LENGTH"] = "the value of Body.length";
      BYTE_LENGTH_SOURCE2["SIZE"] = "the value of Body.size";
      BYTE_LENGTH_SOURCE2["START_END_DIFF"] = "the numeric difference between Body.start and Body.end";
      BYTE_LENGTH_SOURCE2["LSTAT"] = "the size of the file given by Body.path on disk as reported by lstatSync";
    })(BYTE_LENGTH_SOURCE || (BYTE_LENGTH_SOURCE = {}));
    var byteLengthSource = /* @__PURE__ */ __name((input, override) => {
      if (override != null) {
        return BYTE_LENGTH_SOURCE.CONTENT_LENGTH;
      }
      if (input == null) {
        return BYTE_LENGTH_SOURCE.EMPTY_INPUT;
      }
      if (typeof input === "string") {
        return BYTE_LENGTH_SOURCE.STRING_LENGTH;
      }
      if (typeof input.byteLength === "number") {
        return BYTE_LENGTH_SOURCE.TYPED_ARRAY;
      } else if (typeof input.length === "number") {
        return BYTE_LENGTH_SOURCE.LENGTH;
      } else if (typeof input.size === "number") {
        return BYTE_LENGTH_SOURCE.SIZE;
      } else if (typeof input.start === "number" && typeof input.end === "number") {
        return BYTE_LENGTH_SOURCE.START_END_DIFF;
      } else if (runtimeConfig.isFileReadStream(input)) {
        try {
          runtimeConfig.lstatSync(input.path).size;
          return BYTE_LENGTH_SOURCE.LSTAT;
        } catch (error) {
          return void 0;
        }
      }
      return void 0;
    }, "byteLengthSource");
    async function* getChunkStream(data, partSize, getNextData) {
      let partNumber = 1;
      const currentBuffer = { chunks: [], length: 0 };
      for await (const datum of getNextData(data)) {
        currentBuffer.chunks.push(datum);
        currentBuffer.length += datum.byteLength;
        while (currentBuffer.length > partSize) {
          const dataChunk = currentBuffer.chunks.length > 1 ? Buffer.concat(currentBuffer.chunks) : currentBuffer.chunks[0];
          yield {
            partNumber,
            data: dataChunk.subarray(0, partSize)
          };
          currentBuffer.chunks = [dataChunk.subarray(partSize)];
          currentBuffer.length = currentBuffer.chunks[0].byteLength;
          partNumber += 1;
        }
      }
      yield {
        partNumber,
        data: currentBuffer.chunks.length !== 1 ? Buffer.concat(currentBuffer.chunks) : currentBuffer.chunks[0],
        lastPart: true
      };
    }
    __name(getChunkStream, "getChunkStream");
    async function* getChunkUint8Array(data, partSize) {
      let partNumber = 1;
      let startByte = 0;
      let endByte = partSize;
      while (endByte < data.byteLength) {
        yield {
          partNumber,
          data: data.subarray(startByte, endByte)
        };
        partNumber += 1;
        startByte = endByte;
        endByte = startByte + partSize;
      }
      yield {
        partNumber,
        data: data.subarray(startByte),
        lastPart: true
      };
    }
    __name(getChunkUint8Array, "getChunkUint8Array");
    async function* getDataReadable(data) {
      for await (const chunk of data) {
        if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
          yield chunk;
        } else {
          yield Buffer.from(chunk);
        }
      }
    }
    __name(getDataReadable, "getDataReadable");
    async function* getDataReadableStream(data) {
      const reader = data.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
            yield value;
          } else {
            yield Buffer.from(value);
          }
        }
      } catch (e) {
        throw e;
      } finally {
        reader.releaseLock();
      }
    }
    __name(getDataReadableStream, "getDataReadableStream");
    var getChunk = /* @__PURE__ */ __name((data, partSize) => {
      if (data instanceof Uint8Array) {
        return getChunkUint8Array(data, partSize);
      }
      if (data instanceof Readable2) {
        return getChunkStream(data, partSize, getDataReadable);
      }
      if (data instanceof String || typeof data === "string") {
        return getChunkUint8Array(Buffer.from(data), partSize);
      }
      if (typeof data.stream === "function") {
        return getChunkStream(data.stream(), partSize, getDataReadableStream);
      }
      if (data instanceof ReadableStream) {
        return getChunkStream(data, partSize, getDataReadableStream);
      }
      throw new Error("Body Data is unsupported format, expected data to be one of: string | Uint8Array | Buffer | Readable | ReadableStream | Blob;.");
    }, "getChunk");
    var Upload2 = class _Upload extends EventEmitter {
      static {
        __name(this, "Upload");
      }
      static MIN_PART_SIZE = 1024 * 1024 * 5;
      MAX_PARTS = 1e4;
      queueSize = 4;
      partSize;
      leavePartsOnError = false;
      tags = [];
      client;
      params;
      totalBytes;
      totalBytesSource;
      bytesUploadedSoFar;
      abortController;
      concurrentUploaders = [];
      createMultiPartPromise;
      abortMultipartUploadCommand = null;
      uploadedParts = [];
      uploadEnqueuedPartsCount = 0;
      expectedPartsCount;
      uploadId;
      uploadEvent;
      isMultiPart = true;
      singleUploadResult;
      sent = false;
      constructor(options) {
        super();
        this.queueSize = options.queueSize || this.queueSize;
        this.leavePartsOnError = options.leavePartsOnError || this.leavePartsOnError;
        this.tags = options.tags || this.tags;
        this.client = options.client;
        this.params = options.params;
        if (!this.params) {
          throw new Error(`InputError: Upload requires params to be passed to upload.`);
        }
        this.totalBytes = this.params.ContentLength ?? byteLength(this.params.Body);
        this.totalBytesSource = byteLengthSource(this.params.Body, this.params.ContentLength);
        this.bytesUploadedSoFar = 0;
        this.abortController = options.abortController ?? new AbortController();
        this.partSize = options.partSize || Math.max(_Upload.MIN_PART_SIZE, Math.ceil((this.totalBytes || 0) / this.MAX_PARTS));
        if (this.totalBytes !== void 0) {
          this.expectedPartsCount = Math.ceil(this.totalBytes / this.partSize);
        }
        this.__validateInput();
      }
      async abort() {
        this.abortController.abort();
      }
      async done() {
        if (this.sent) {
          throw new Error("@aws-sdk/lib-storage: this instance of Upload has already executed .done(). Create a new instance.");
        }
        this.sent = true;
        return await Promise.race([this.__doMultipartUpload(), this.__abortTimeout(this.abortController.signal)]);
      }
      on(event, listener) {
        this.uploadEvent = event;
        return super.on(event, listener);
      }
      async __uploadUsingPut(dataPart) {
        this.isMultiPart = false;
        const params = { ...this.params, Body: dataPart.data };
        const clientConfig = this.client.config;
        const requestHandler = clientConfig.requestHandler;
        const eventEmitter = requestHandler instanceof EventEmitter ? requestHandler : null;
        const uploadEventListener = /* @__PURE__ */ __name((event) => {
          this.bytesUploadedSoFar = event.loaded;
          this.totalBytes = event.total;
          this.__notifyProgress({
            loaded: this.bytesUploadedSoFar,
            total: this.totalBytes,
            part: dataPart.partNumber,
            Key: this.params.Key,
            Bucket: this.params.Bucket
          });
        }, "uploadEventListener");
        if (eventEmitter !== null) {
          eventEmitter.on("xhr.upload.progress", uploadEventListener);
        }
        const resolved = await Promise.all([this.client.send(new PutObjectCommand(params)), clientConfig?.endpoint?.()]);
        const putResult = resolved[0];
        let endpoint = resolved[1];
        if (!endpoint) {
          endpoint = toEndpointV1(await getEndpointFromInstructions(params, PutObjectCommand, {
            ...clientConfig
          }));
        }
        if (!endpoint) {
          throw new Error('Could not resolve endpoint from S3 "client.config.endpoint()" nor EndpointsV2.');
        }
        if (eventEmitter !== null) {
          eventEmitter.off("xhr.upload.progress", uploadEventListener);
        }
        const locationKey = this.params.Key.split("/").map((segment) => extendedEncodeURIComponent(segment)).join("/");
        const locationBucket = extendedEncodeURIComponent(this.params.Bucket);
        const Location = (() => {
          const endpointHostnameIncludesBucket = endpoint.hostname.startsWith(`${locationBucket}.`);
          const forcePathStyle = this.client.config.forcePathStyle;
          const optionalPort = endpoint.port ? `:${endpoint.port}` : ``;
          if (forcePathStyle) {
            return `${endpoint.protocol}//${endpoint.hostname}${optionalPort}/${locationBucket}/${locationKey}`;
          }
          if (endpointHostnameIncludesBucket) {
            return `${endpoint.protocol}//${endpoint.hostname}${optionalPort}/${locationKey}`;
          }
          return `${endpoint.protocol}//${locationBucket}.${endpoint.hostname}${optionalPort}/${locationKey}`;
        })();
        this.singleUploadResult = {
          ...putResult,
          Bucket: this.params.Bucket,
          Key: this.params.Key,
          Location
        };
        const totalSize = byteLength(dataPart.data);
        this.__notifyProgress({
          loaded: totalSize,
          total: totalSize,
          part: 1,
          Key: this.params.Key,
          Bucket: this.params.Bucket
        });
      }
      async __createMultipartUpload() {
        const requestChecksumCalculation = await this.client.config.requestChecksumCalculation();
        if (!this.createMultiPartPromise) {
          const createCommandParams = { ...this.params, Body: void 0 };
          if (requestChecksumCalculation === "WHEN_SUPPORTED") {
            createCommandParams.ChecksumAlgorithm = this.params.ChecksumAlgorithm || ChecksumAlgorithm.CRC32;
          }
          this.createMultiPartPromise = this.client.send(new CreateMultipartUploadCommand(createCommandParams)).then((createMpuResponse) => {
            this.abortMultipartUploadCommand = new AbortMultipartUploadCommand({
              Bucket: this.params.Bucket,
              Key: this.params.Key,
              UploadId: createMpuResponse.UploadId
            });
            return createMpuResponse;
          });
        }
        return this.createMultiPartPromise;
      }
      async __doConcurrentUpload(dataFeeder) {
        for await (const dataPart of dataFeeder) {
          if (this.uploadEnqueuedPartsCount > this.MAX_PARTS) {
            throw new Error(`Exceeded ${this.MAX_PARTS} parts in multipart upload to Bucket: ${this.params.Bucket} Key: ${this.params.Key}.`);
          }
          if (this.abortController.signal.aborted) {
            return;
          }
          if (dataPart.partNumber === 1 && dataPart.lastPart) {
            return await this.__uploadUsingPut(dataPart);
          }
          if (!this.uploadId) {
            const { UploadId } = await this.__createMultipartUpload();
            this.uploadId = UploadId;
            if (this.abortController.signal.aborted) {
              return;
            }
          }
          const partSize = byteLength(dataPart.data) || 0;
          const requestHandler = this.client.config.requestHandler;
          const eventEmitter = requestHandler instanceof EventEmitter ? requestHandler : null;
          let lastSeenBytes = 0;
          const uploadEventListener = /* @__PURE__ */ __name((event, request) => {
            const requestPartSize = Number(request.query["partNumber"]) || -1;
            if (requestPartSize !== dataPart.partNumber) {
              return;
            }
            if (event.total && partSize) {
              this.bytesUploadedSoFar += event.loaded - lastSeenBytes;
              lastSeenBytes = event.loaded;
            }
            this.__notifyProgress({
              loaded: this.bytesUploadedSoFar,
              total: this.totalBytes,
              part: dataPart.partNumber,
              Key: this.params.Key,
              Bucket: this.params.Bucket
            });
          }, "uploadEventListener");
          if (eventEmitter !== null) {
            eventEmitter.on("xhr.upload.progress", uploadEventListener);
          }
          this.uploadEnqueuedPartsCount += 1;
          this.__validateUploadPart(dataPart);
          const partResult = await this.client.send(new UploadPartCommand({
            ...this.params,
            ContentLength: void 0,
            UploadId: this.uploadId,
            Body: dataPart.data,
            PartNumber: dataPart.partNumber
          }));
          if (eventEmitter !== null) {
            eventEmitter.off("xhr.upload.progress", uploadEventListener);
          }
          if (this.abortController.signal.aborted) {
            return;
          }
          if (!partResult.ETag) {
            throw new Error(`Part ${dataPart.partNumber} is missing ETag in UploadPart response. Missing Bucket CORS configuration for ETag header?`);
          }
          this.uploadedParts.push({
            PartNumber: dataPart.partNumber,
            ETag: partResult.ETag,
            ...partResult.ChecksumCRC32 && { ChecksumCRC32: partResult.ChecksumCRC32 },
            ...partResult.ChecksumCRC32C && { ChecksumCRC32C: partResult.ChecksumCRC32C },
            ...partResult.ChecksumSHA1 && { ChecksumSHA1: partResult.ChecksumSHA1 },
            ...partResult.ChecksumSHA256 && { ChecksumSHA256: partResult.ChecksumSHA256 }
          });
          if (eventEmitter === null) {
            this.bytesUploadedSoFar += partSize;
          }
          this.__notifyProgress({
            loaded: this.bytesUploadedSoFar,
            total: this.totalBytes,
            part: dataPart.partNumber,
            Key: this.params.Key,
            Bucket: this.params.Bucket
          });
        }
      }
      async __doMultipartUpload() {
        const dataFeeder = getChunk(this.params.Body, this.partSize);
        const concurrentUploaderFailures = [];
        for (let index = 0; index < this.queueSize; index++) {
          const currentUpload = this.__doConcurrentUpload(dataFeeder).catch((err) => {
            concurrentUploaderFailures.push(err);
          });
          this.concurrentUploaders.push(currentUpload);
        }
        await Promise.all(this.concurrentUploaders);
        if (concurrentUploaderFailures.length >= 1) {
          await this.markUploadAsAborted();
          throw concurrentUploaderFailures[0];
        }
        if (this.abortController.signal.aborted) {
          await this.markUploadAsAborted();
          throw Object.assign(new Error("Upload aborted."), { name: "AbortError" });
        }
        let result;
        if (this.isMultiPart) {
          const { expectedPartsCount, uploadedParts, totalBytes, totalBytesSource } = this;
          if (totalBytes !== void 0 && expectedPartsCount !== void 0 && uploadedParts.length !== expectedPartsCount) {
            throw new Error(`Expected ${expectedPartsCount} part(s) but uploaded ${uploadedParts.length} part(s).
The expected part count is based on the byte-count of the input.params.Body,
which was read from ${totalBytesSource} and is ${totalBytes}.
If this is not correct, provide an override value by setting a number
to input.params.ContentLength in bytes.
`);
          }
          this.uploadedParts.sort((a, b) => a.PartNumber - b.PartNumber);
          const uploadCompleteParams = {
            ...this.params,
            Body: void 0,
            UploadId: this.uploadId,
            MultipartUpload: {
              Parts: this.uploadedParts
            }
          };
          result = await this.client.send(new CompleteMultipartUploadCommand(uploadCompleteParams));
          if (typeof result?.Location === "string" && result.Location.includes("%2F")) {
            result.Location = result.Location.replace(/%2F/g, "/");
          }
        } else {
          result = this.singleUploadResult;
        }
        this.abortMultipartUploadCommand = null;
        if (this.tags.length) {
          await this.client.send(new PutObjectTaggingCommand({
            ...this.params,
            Tagging: {
              TagSet: this.tags
            }
          }));
        }
        return result;
      }
      async markUploadAsAborted() {
        if (this.uploadId && !this.leavePartsOnError && null !== this.abortMultipartUploadCommand) {
          await this.client.send(this.abortMultipartUploadCommand);
          this.abortMultipartUploadCommand = null;
        }
      }
      __notifyProgress(progress) {
        if (this.uploadEvent) {
          this.emit(this.uploadEvent, progress);
        }
      }
      async __abortTimeout(abortSignal) {
        return new Promise((resolve, reject) => {
          abortSignal.onabort = () => {
            const abortError = new Error("Upload aborted.");
            abortError.name = "AbortError";
            reject(abortError);
          };
        });
      }
      __validateUploadPart(dataPart) {
        const actualPartSize = byteLength(dataPart.data);
        if (actualPartSize === void 0) {
          throw new Error(`A dataPart was generated without a measurable data chunk size for part number ${dataPart.partNumber}`);
        }
        if (dataPart.partNumber === 1 && dataPart.lastPart) {
          return;
        }
        if (!dataPart.lastPart && actualPartSize !== this.partSize) {
          throw new Error(`The byte size for part number ${dataPart.partNumber}, size ${actualPartSize} does not match expected size ${this.partSize}`);
        }
      }
      __validateInput() {
        if (!this.client) {
          throw new Error(`InputError: Upload requires a AWS client to do uploads with.`);
        }
        if (this.partSize < _Upload.MIN_PART_SIZE) {
          throw new Error(`EntityTooSmall: Your proposed upload part size [${this.partSize}] is smaller than the minimum allowed size [${_Upload.MIN_PART_SIZE}] (5MB)`);
        }
        if (this.queueSize < 1) {
          throw new Error(`Queue size: Must have at least one uploading queue.`);
        }
      }
    };
    exports.Upload = Upload2;
  }
});

// trigger/provider-recording-ingest.ts
init_esm();
var import_client_s3 = __toESM(require_dist_cjs());
var import_lib_storage = __toESM(require_dist_cjs2());
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
__name(requiredEnvironment, "requiredEnvironment");
function allowedRecordingHosts() {
  const entries = requiredEnvironment("IVR_RECORDING_ALLOWED_HOSTS").split(",").map((entry) => entry.trim().toLocaleLowerCase()).filter(Boolean);
  if (entries.length === 0) throw new Error("IVR_RECORDING_ALLOWED_HOSTS_EMPTY");
  return entries;
}
__name(allowedRecordingHosts, "allowedRecordingHosts");
function validatedProviderUrl(rawUrl, allowedHosts) {
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLocaleLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname) !== 0)
    throw new Error("PROVIDER_RECORDING_URL_REJECTED");
  const allowed = allowedHosts.some(
    (entry) => entry.startsWith("*.") ? hostname.endsWith(entry.slice(1)) && hostname !== entry.slice(2) : hostname === entry
  );
  if (!allowed) throw new Error("PROVIDER_RECORDING_HOST_NOT_ALLOWED");
  return url;
}
__name(validatedProviderUrl, "validatedProviderUrl");
async function fetchRecording(initialUrl, allowedHosts, signal) {
  let url = validatedProviderUrl(initialUrl, allowedHosts);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(url, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("PROVIDER_RECORDING_REDIRECT_INVALID");
    url = validatedProviderUrl(new URL(location, url).toString(), allowedHosts);
  }
  throw new Error("PROVIDER_RECORDING_TOO_MANY_REDIRECTS");
}
__name(fetchRecording, "fetchRecording");
function maximumRecordingBytes() {
  const configured = Number(process.env.MAX_RECORDING_BYTES ?? 104857600);
  if (!Number.isSafeInteger(configured) || configured < 1048576 || configured > 1073741824)
    throw new Error("MAX_RECORDING_BYTES_INVALID");
  return configured;
}
__name(maximumRecordingBytes, "maximumRecordingBytes");
function acceptedMimeType(value) {
  const normalized = value.split(";", 1)[0]?.trim().toLocaleLowerCase() ?? "";
  const allowed = /* @__PURE__ */ new Set([
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "audio/webm"
  ]);
  if (!allowed.has(normalized)) throw new Error("PROVIDER_RECORDING_MIME_REJECTED");
  return normalized;
}
__name(acceptedMimeType, "acceptedMimeType");
var providerRecordingIngest = task({
  id: "provider-recording-ingest",
  retry: {
    maxAttempts: 7,
    factor: 2,
    minTimeoutInMs: 1e3,
    maxTimeoutInMs: 6e4,
    randomize: true
  },
  run: /* @__PURE__ */ __name(async (payload) => {
    const required = [
      "TIGRIS_ENDPOINT",
      "TIGRIS_BUCKET",
      "TIGRIS_ACCESS_KEY_ID",
      "TIGRIS_SECRET_ACCESS_KEY",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY"
    ];
    for (const key of required) requiredEnvironment(key);
    const maximumBytes = maximumRecordingBytes();
    if (payload.expectedBytes !== void 0 && (!Number.isSafeInteger(payload.expectedBytes) || payload.expectedBytes < 0 || payload.expectedBytes > maximumBytes))
      throw new Error("PROVIDER_RECORDING_EXPECTED_SIZE_INVALID");
    const requestedMimeType = acceptedMimeType(payload.mimeType);
    const response = await fetchRecording(
      payload.providerRecordingUrl,
      allowedRecordingHosts(),
      AbortSignal.timeout(5 * 6e4)
    );
    if (!response.ok || !response.body)
      throw new Error(`PROVIDER_RECORDING_DOWNLOAD_${response.status}`);
    const responseMimeType = acceptedMimeType(
      response.headers.get("content-type") ?? requestedMimeType
    );
    if (responseMimeType !== requestedMimeType) throw new Error("PROVIDER_RECORDING_MIME_MISMATCH");
    const declaredBytes = Number(response.headers.get("content-length") ?? "0");
    if (declaredBytes > maximumBytes) throw new Error("PROVIDER_RECORDING_TOO_LARGE");
    let actualBytes = 0;
    const digest = createHash("sha256");
    const boundedStream = Readable.fromWeb(response.body).pipe(
      new Transform({
        transform(chunk, _encoding, callback) {
          actualBytes += chunk.byteLength;
          if (actualBytes > maximumBytes) {
            callback(new Error("PROVIDER_RECORDING_TOO_LARGE"));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        }
      })
    );
    const objectKey = `${payload.organizationId}/call-recordings/${payload.callId}/${payload.recordingId}`;
    const storage = new import_client_s3.S3Client({
      endpoint: requiredEnvironment("TIGRIS_ENDPOINT"),
      region: process.env.TIGRIS_REGION ?? "auto",
      credentials: {
        accessKeyId: requiredEnvironment("TIGRIS_ACCESS_KEY_ID"),
        secretAccessKey: requiredEnvironment("TIGRIS_SECRET_ACCESS_KEY")
      }
    });
    await new import_lib_storage.Upload({
      client: storage,
      params: {
        Bucket: requiredEnvironment("TIGRIS_BUCKET"),
        Key: objectKey,
        Body: boundedStream,
        ContentType: responseMimeType
      },
      leavePartsOnError: false,
      queueSize: 2,
      partSize: 8 * 1024 * 1024
    }).done();
    if (payload.expectedBytes !== void 0 && actualBytes !== payload.expectedBytes) {
      await storage.send(
        new import_client_s3.DeleteObjectCommand({ Bucket: requiredEnvironment("TIGRIS_BUCKET"), Key: objectKey })
      );
      throw new Error("PROVIDER_RECORDING_SIZE_MISMATCH");
    }
    const checksum = digest.digest("hex");
    const supabase = createClient(
      requiredEnvironment("SUPABASE_URL"),
      requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data: file, error: fileError } = await supabase.from("object_files").upsert(
      {
        organization_id: payload.organizationId,
        branch_id: payload.branchId,
        resource_type: "call",
        resource_id: payload.callId,
        bucket: requiredEnvironment("TIGRIS_BUCKET"),
        object_key: objectKey,
        mime_type: responseMimeType,
        size_bytes: actualBytes,
        checksum,
        uploaded_by: null
      },
      { onConflict: "bucket,object_key" }
    ).select("id").single();
    if (fileError) throw fileError;
    const { data: recording, error: recordingError } = await supabase.from("call_recordings").update({ object_file_id: file.id, status: "READY", checksum }).eq("id", payload.recordingId).eq("organization_id", payload.organizationId).eq("call_id", payload.callId).select("id").maybeSingle();
    if (recordingError || !recording) throw recordingError ?? new Error("CALL_RECORDING_NOT_FOUND");
    return { objectFileId: file.id, sizeBytes: actualBytes, checksum };
  }, "run")
});
export {
  providerRecordingIngest
};
//# sourceMappingURL=provider-recording-ingest.mjs.map
