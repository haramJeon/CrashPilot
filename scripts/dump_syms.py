from dataclasses import replace
import errno
from logging import exception
from posixpath import dirname
import argparse
import os
import shutil
from os.path import basename
from pathlib import Path

def create_diectory_recursive(path):
	try:
		os.makedirs(path)
	except OSError as exception:
		if exception.errno != errno.EEXIST:
			raise

def run_command(command):
	print(command)
	os.system(command)

def main():
	parser = argparse.ArgumentParser()
	parser.add_argument('dumpsyms_cmd_path', type=str, help='input : dumpsyms executable path')
	parser.add_argument('dsym_path', type=str, help='input : path contains *.dSYM files')
	parser.add_argument('sym_path', type=str, help='output : path create *.sym files')
	args = parser.parse_args()

	dumpsyms_cmd_path = args.dumpsyms_cmd_path
	dsym_path = args.dsym_path
	sym_path = args.sym_path
	dSYM_files = list()
	sym_files = list()

	if not os.path.exists(sym_path):
		os.mkdir(sym_path)

	for path in Path(dsym_path).rglob('*.dSYM'):
		dSYM_files.append(os.path.abspath(path))

	for path in Path(dsym_path).rglob('*.sym'):
		sym_files.append(os.path.abspath(path))

	if len(dSYM_files) > 0 and len(sym_files) == 0:
		for sym in dSYM_files:
			print ("symbol file name - " + sym)
			if not os.path.exists(sym):
				print('%s file not exists' % sym)
				continue

			output_symbol_path = os.path.join(os.path.abspath(sym_path), basename(sym).split(".")[0] + ".sym")
			if not os.path.exists(output_symbol_path):
				dumpsyms_cmd_args = dumpsyms_cmd_path + " " + sym.replace(" ", "\\ ") + " > " + output_symbol_path
				print(dumpsyms_cmd_args)
				run_command(dumpsyms_cmd_args)
			else:
				print("skip create symbol - " + output_symbol_path)

			# breakpad directory rule example : ~/libMeditUIFramework.dylib/0ED3E3949BA03F19B5B138036CC5C7340/libMeditUIFramework.dylib.sym
			symFile = open(output_symbol_path, "r")
			firstLine = symFile.read().splitlines()[0]
			lineArguments = firstLine.split(' ')
			symbol_directory_path = sym_path + "/" + lineArguments[-1] + "/" + lineArguments[-2]
			symbol_file_path = os.path.join(symbol_directory_path, lineArguments[-1] + ".sym")

			create_diectory_recursive(symbol_directory_path)
			if not os.path.exists(symbol_file_path):
				shutil.move(output_symbol_path, symbol_file_path)
			else:
				print("remote symbol file alread exist - " + symbol_file_path)
	elif len(dSYM_files) > 0 and len(dSYM_files) == len(sym_files):
		print('symbols alredy created. count : %d' %len(sym_files))
	else:
		raise

main()
