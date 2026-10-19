import sys

# scode 是用完即弃的本地入口：不在源码目录留下任何 __pycache__ 产物。
# 必须在导入本包其他模块之前设置；main.py 启动的子进程还会通过环境变量再保一层。
sys.dont_write_bytecode = True


def start():
    from stupid_code.main import main
    main()
