#!/usr/bin/env python3
"""Move the emulator's *physical model* (which also moves its virtual-scene camera) over gRPC.

`adb emu sensor set …` only overrides one sensor's reading: the camera picture stays the same.
This sets the device pose itself, so the orientation sensors AND the camera view change together,
as when a real phone is turned or carried.

    emu_pose.py <grpc-port> get
    emu_pose.py <grpc-port> rot <x> <y> <z>     degrees (y = yaw about the vertical axis)
    emu_pose.py <grpc-port> pos <x> <y> <z>     metres

The port is printed by `adb emu grpc <port>`; the access token is read from the emulator's
discovery file ($XDG_RUNTIME_DIR/avd/running/pid_*.ini). Needs grpcio and stubs generated from the SDK:
    python -m grpc_tools.protoc -I $ANDROID_SDK/emulator/lib --python_out=DIR --grpc_python_out=DIR \
        $ANDROID_SDK/emulator/lib/emulator_controller.proto
and DIR on PYTHONPATH.
"""
import glob
import os
import sys

import grpc
import emulator_controller_pb2 as pb
import emulator_controller_pb2_grpc as rpc


def main() -> int:
    port, cmd = sys.argv[1], sys.argv[2]
    stub = rpc.EmulatorControllerStub(grpc.insecure_channel(f"localhost:{port}"))
    T = pb.PhysicalModelValue
    md = []
    for ini in glob.glob(os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/run/user/%d" % os.getuid()), "avd/running/pid_*.ini")):
        kv = dict(line.strip().split("=", 1) for line in open(ini) if "=" in line)
        if kv.get("grpc.port") == port and kv.get("grpc.token"):
            md = [("authorization", "Bearer " + kv["grpc.token"])]

    def get(t):
        return [round(v, 4) for v in stub.getPhysicalModel(T(target=t), timeout=10, metadata=md).value.data]

    def put(t, v):
        stub.setPhysicalModel(T(target=t, value=pb.ParameterValue(data=v)), timeout=10, metadata=md)

    if cmd == "rot":
        put(T.ROTATION, [float(x) for x in sys.argv[3:6]])
    elif cmd == "pos":
        put(T.POSITION, [float(x) for x in sys.argv[3:6]])
    print("rotation", get(T.ROTATION), "position", get(T.POSITION), "magnetic", get(T.MAGNETIC_FIELD))
    return 0


if __name__ == "__main__":
    sys.exit(main())
